// Temporary compatibility for Bun 1.4.2's package-bin syscalls on Android.
// Remove after adopting Bun's upstream Android seccomp fallback fix.
// https://github.com/oven-sh/bun/issues/39060
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <linux/audit.h>
#include <pthread.h>
#include <signal.h>
#include <stdatomic.h>
#include <stdlib.h>
#include <sys/syscall.h>
#include <ucontext.h>
#include <unistd.h>

#if !defined(__ANDROID__) || !defined(__aarch64__)
#error This compatibility library requires Android ARM64 platform headers.
#endif

typedef int (*sigaction_fn)(int, const struct sigaction *, struct sigaction *);
static sigaction_fn system_sigaction;
static sighandler_t (*system_signal)(int, sighandler_t);
static pthread_once_t initialized = PTHREAD_ONCE_INIT;
static pthread_mutex_t action_lock = PTHREAD_MUTEX_INITIALIZER;
static struct sigaction default_action;
static struct sigaction initial_action;
static _Atomic(struct sigaction *) forwarded_action = &initial_action;

static void handle_sigsys(int signo, siginfo_t *info, void *context) {
    if (info && context && info->si_code == SYS_SECCOMP &&
        info->si_arch == AUDIT_ARCH_AARCH64 &&
        (info->si_syscall == __NR_openat2 || info->si_syscall == __NR_fchmodat2)) {
        // The syscall remains unavailable. Let Bun use its existing containment
        // and no-follow permission fallbacks, as it does on older Linux kernels.
        ((ucontext_t *)context)->uc_mcontext.regs[0] = (unsigned long)-ENOSYS;
        return;
    }

    struct sigaction *action = atomic_load_explicit(&forwarded_action, memory_order_acquire);
    if (action->sa_handler == SIG_IGN) return;
    if (action->sa_handler == SIG_DFL) {
        system_sigaction(signo, &default_action, NULL);
        raise(signo);
        return;
    }
    if (action->sa_flags & SA_RESETHAND) {
        struct sigaction *expected = action;
        atomic_compare_exchange_strong(&forwarded_action, &expected, &default_action);
    }
    if (action->sa_flags & SA_SIGINFO) action->sa_sigaction(signo, info, context);
    else action->sa_handler(signo);
}

static struct sigaction wrapped_action(const struct sigaction *action) {
    struct sigaction wrapped = *action;
    wrapped.sa_sigaction = handle_sigsys;
    // Reset the forwarded disposition ourselves, keeping fallback handling alive.
    wrapped.sa_flags = (wrapped.sa_flags & ~SA_RESETHAND) | SA_SIGINFO;
    return wrapped;
}

static void initialize(void) {
    system_sigaction = (sigaction_fn)dlsym(RTLD_NEXT, "sigaction");
    system_signal = (sighandler_t (*)(int, sighandler_t))dlsym(RTLD_NEXT, "signal");
    if (!system_sigaction || !system_signal) _exit(127);
    sigemptyset(&default_action.sa_mask);
    default_action.sa_handler = SIG_DFL;
    if (system_sigaction(SIGSYS, NULL, &initial_action) != 0) _exit(127);
    struct sigaction wrapped = wrapped_action(&initial_action);
    if (system_sigaction(SIGSYS, &wrapped, NULL) != 0) _exit(127);
}

__attribute__((constructor)) static void load_compatibility(void) {
    pthread_once(&initialized, initialize);
}

// Bun resets signal dispositions during startup. Keep the fallback installed
// while preserving its requested handler and sigaction's old-action contract.
int sigaction(int signo, const struct sigaction *action, struct sigaction *old_action) {
    pthread_once(&initialized, initialize);
    if (signo != SIGSYS) return system_sigaction(signo, action, old_action);

    struct sigaction *next = NULL;
    if (action) {
        next = malloc(sizeof(*next));
        if (!next) { errno = ENOMEM; return -1; }
        *next = *action;
    }
    pthread_mutex_lock(&action_lock);
    struct sigaction *previous = atomic_load_explicit(&forwarded_action, memory_order_acquire);
    int result = 0;
    if (next) {
        struct sigaction wrapped = wrapped_action(next);
        result = system_sigaction(signo, &wrapped, NULL);
        if (result == 0) atomic_store_explicit(&forwarded_action, next, memory_order_release);
    }
    if (result == 0 && old_action) *old_action = *previous;
    pthread_mutex_unlock(&action_lock);
    if (result != 0) free(next);
    // Successful records stay immutable until process exit: an interrupted
    // thread may still be forwarding a signal through an earlier disposition.
    return result;
}

sighandler_t signal(int signo, sighandler_t handler) {
    pthread_once(&initialized, initialize);
    if (signo != SIGSYS) return system_signal(signo, handler);
    struct sigaction action = { .sa_handler = handler, .sa_flags = SA_RESTART }, previous;
    sigemptyset(&action.sa_mask);
    return sigaction(signo, &action, &previous) == 0 ? previous.sa_handler : SIG_ERR;
}
