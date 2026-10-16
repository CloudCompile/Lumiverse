// Emulator-only regression fixture. Never packaged in the APK.
#define _GNU_SOURCE
#include <assert.h>
#include <errno.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <signal.h>
#include <stddef.h>
#include <stdio.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <ucontext.h>
#include <unistd.h>

static void restrict_installer(void) {
    struct sock_filter filter[] = {
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_openat2, 3, 0),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_fchmodat2, 2, 0),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_getppid, 1, 0),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_TRAP),
    };
    struct sock_fprog program = { .len = sizeof(filter) / sizeof(filter[0]), .filter = filter };
    assert(prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) == 0);
    assert(prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &program) == 0);
}

static volatile sig_atomic_t signals_seen;
static void ordinary_handler(int signo) { assert(signo == SIGSYS); signals_seen++; }
static void detailed_handler(int signo, siginfo_t *info, void *context) {
    assert(signo == SIGSYS && info->si_syscall == __NR_getppid);
    signals_seen++;
    ((ucontext_t *)context)->uc_mcontext.regs[0] = (unsigned long)-EPERM;
}
static void check_fallbacks(void) {
    errno = 0;
    assert(syscall(__NR_openat2, -1, NULL, NULL, 0) == -1 && errno == ENOSYS);
    errno = 0;
    assert(syscall(__NR_fchmodat2, -1, NULL, 0, 0) == -1 && errno == ENOSYS);
}

int main(int argc, char **argv) {
    assert(argc >= 2);
    restrict_installer();
    if (strcmp(argv[1], "exec") == 0) {
        assert(argc >= 3);
        execv(argv[2], &argv[2]);
        perror("execv");
        return 1;
    }
    if (strcmp(argv[1], "user-signal") == 0) { raise(SIGSYS); return 1; }
    if (strcmp(argv[1], "unknown-syscall") == 0) { syscall(__NR_getppid); return 1; }
    assert(strcmp(argv[1], "probe") == 0);
    check_fallbacks();
    struct sigaction action = { .sa_handler = ordinary_handler, .sa_flags = SA_RESTART }, previous, queried;
    sigemptyset(&action.sa_mask);
    assert(sigaction(SIGSYS, NULL, &queried) == 0);
    // Android's crash reporter may already own the initial signal disposition.
    assert(sigaction(SIGSYS, &action, &previous) == 0 && previous.sa_handler == queried.sa_handler);
    assert(sigaction(SIGSYS, NULL, &queried) == 0 && queried.sa_handler == ordinary_handler);
    check_fallbacks();
    raise(SIGSYS);
    assert(signals_seen == 1);
    action.sa_sigaction = detailed_handler;
    action.sa_flags = SA_SIGINFO;
    assert(sigaction(SIGSYS, &action, &previous) == 0 && previous.sa_handler == ordinary_handler);
    assert(syscall(__NR_getppid) == -1 && errno == EPERM && signals_seen == 2);
    assert(signal(SIGSYS, SIG_IGN) == (sighandler_t)detailed_handler);
    raise(SIGSYS);
    assert(signals_seen == 2);
    assert(signal(SIGSYS, SIG_DFL) == SIG_IGN);
    check_fallbacks();
    puts("ENOSYS fallbacks and signal forwarding passed");
    return 0;
}
