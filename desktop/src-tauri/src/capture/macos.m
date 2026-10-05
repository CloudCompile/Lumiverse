#import <Cocoa/Cocoa.h>
#import <CoreGraphics/CoreGraphics.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#import <AVFoundation/AVFoundation.h>
#import <AVKit/AVKit.h>
#import <VideoToolbox/VideoToolbox.h>
#include <stdatomic.h>
#include <errno.h>
#include <math.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <signal.h>
#include <unistd.h>

typedef void (*CaptureCallback)(void *, uint32_t, const uint8_t *, size_t, uint32_t, uint32_t, double);

static BOOL HardwareH264Available(void) {
    VTCompressionSessionRef session = NULL;
    NSDictionary *specification = @{ (__bridge NSString *)kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder: @YES };
    OSStatus status = VTCompressionSessionCreate(kCFAllocatorDefault, 1920, 1080, kCMVideoCodecType_H264,
        (__bridge CFDictionaryRef)specification, NULL, NULL, NULL, NULL, &session);
    if (status != noErr || !session) return NO;
    status = VTCompressionSessionPrepareToEncodeFrames(session);
    CFTypeRef hardware = NULL;
    if (status == noErr) status = VTSessionCopyProperty(session, kVTCompressionPropertyKey_UsingHardwareAcceleratedVideoEncoder, kCFAllocatorDefault, &hardware);
    BOOL available = status == noErr && hardware && CFEqual(hardware, kCFBooleanTrue);
    if (hardware) CFRelease(hardware);
    VTCompressionSessionInvalidate(session);
    CFRelease(session);
    return available;
}

static void RemoveAbandonedCaptureDirectories(void) {
    NSFileManager *manager = NSFileManager.defaultManager;
    NSURL *temporary = [NSURL fileURLWithPath:NSTemporaryDirectory() isDirectory:YES];
    NSArray<NSURL *> *entries = [manager contentsOfDirectoryAtURL:temporary includingPropertiesForKeys:@[NSURLIsSymbolicLinkKey, NSURLIsDirectoryKey] options:0 error:nil];
    for (NSURL *entry in entries) {
        if (![entry.lastPathComponent hasPrefix:@"lumiverse-capture-"]) continue;
        NSArray<NSString *> *components = [entry.lastPathComponent componentsSeparatedByString:@"-"];
        if (components.count != 4) continue;
        int process = components[2].intValue;
        if (![[NSString stringWithFormat:@"%d", process] isEqualToString:components[2]] || components[3].length != 6) continue;
        NSNumber *symbolicLink = nil;
        NSNumber *directory = nil;
        [entry getResourceValue:&symbolicLink forKey:NSURLIsSymbolicLinkKey error:nil];
        [entry getResourceValue:&directory forKey:NSURLIsDirectoryKey error:nil];
        if (process > 0 && directory.boolValue && !symbolicLink.boolValue && kill(process, 0) == -1 && errno == ESRCH) {
            [manager removeItemAtURL:entry error:nil];
        }
    }
}

uint32_t lumiverse_capture_capabilities(void) {
    @autoreleasepool {
    if (@available(macOS 14.0, *)) {
        static uint32_t flags;
        static dispatch_once_t once;
        dispatch_once(&once, ^{
            RemoveAbandonedCaptureDirectories();
            flags = 1 | (HardwareH264Available() ? 2 : 0);
        });
        return flags;
    }
    return 0;
    }
}

API_AVAILABLE(macos(14.0))
@interface LumiverseCapture : NSObject <SCContentSharingPickerObserver, SCStreamOutput, SCStreamDelegate, NSWindowDelegate> {
    atomic_bool _completed;
    atomic_bool _cancelled;
    BOOL _finishing;
    BOOL _sourceChosen;
    BOOL _sessionStarted;
    BOOL _permissionRequestAttempted;
    BOOL _loadingSources;
    BOOL _usingPermissionedSources;
    CMTime _firstTime;
    CMTime _lastTime;
    CMSampleBufferRef _lastBuffer;
}
@property NSString *requestID;
@property NSString *consent;
@property NSString *summary;
@property BOOL automaticShare;
@property BOOL video;
@property uint64_t seconds;
@property NSUInteger maximumBytes;
@property uint64_t maximumPixels;
@property uint32_t width;
@property uint32_t height;
@property double duration;
@property NSTimeInterval expiresAt;
@property NSTimeInterval recordStartedAt;
@property CaptureCallback callback;
@property void *context;
@property NSStatusItem *captureIndicator;
@property NSMenuItem *captureStatus;
@property NSMenuItem *reviewAction;
@property NSMenuItem *windowAction;
@property NSMenuItem *displayAction;
@property NSPanel *panel;
@property NSTextField *status;
@property NSTextField *summaryLabel;
@property NSButton *primary;
@property NSButton *detailsButton;
@property NSPopover *detailsPopover;
@property NSPopUpButton *sourcePicker;
@property NSPopUpButton *permissionedSources;
@property NSButton *permissionButton;
@property NSTextField *permissionHelp;
@property SCShareableContent *permissionedContent;
@property SCShareableContentStyle requestedStyle;
@property NSImageView *imageView;
@property AVPlayerView *playerView;
@property NSTimer *timer;
@property SCStream *stream;
@property dispatch_queue_t outputQueue;
@property AVAssetWriter *writer;
@property AVAssetWriterInput *input;
@property AVURLAsset *validationAsset;
@property NSURL *directory;
@property NSURL *outputURL;
@property NSMutableData *imageData;
- (void)start;
- (void)finishOutcome:(uint32_t)outcome;
- (void)captureFilter:(SCContentFilter *)filter;
- (void)captureFailed:(NSError *)error;
- (void)updateStatus:(NSString *)status;
- (void)createPanel;
@end

static LumiverseCapture *currentCapture API_AVAILABLE(macos(14.0));

@implementation LumiverseCapture

- (instancetype)init {
    self = [super init];
    if (self) {
        atomic_init(&_completed, false);
        atomic_init(&_cancelled, false);
        _firstTime = kCMTimeInvalid;
        _lastTime = kCMTimeInvalid;
        self.outputQueue = dispatch_queue_create("chat.lumiverse.capture.frames", DISPATCH_QUEUE_SERIAL);
    }
    return self;
}

- (void)dealloc {
    if (_lastBuffer) CFRelease(_lastBuffer);
}

- (void)start {
    NSLog(@"[Lumiverse capture] pid=%d bundle=%@ packaged=%d screen-recording-access=%d", getpid(),
        NSBundle.mainBundle.bundleIdentifier ?: @"unidentified", [NSBundle.mainBundle.bundlePath.pathExtension isEqualToString:@"app"],
        CGPreflightScreenCaptureAccess());
    self.requestedStyle = SCShareableContentStyleDisplay;
    self.captureIndicator = [NSStatusBar.systemStatusBar statusItemWithLength:NSVariableStatusItemLength];
    self.captureIndicator.button.image = [NSImage imageWithSystemSymbolName:self.video ? @"record.circle" : @"camera" accessibilityDescription:@"Lumiverse capture controls"];
    self.captureIndicator.button.toolTip = self.summary;
    NSMenu *menu = [NSMenu new];
    menu.autoenablesItems = NO;
    for (NSString *line in [self.summary componentsSeparatedByString:@"\n"]) {
        NSMenuItem *identity = [[NSMenuItem alloc] initWithTitle:line action:nil keyEquivalent:@""];
        identity.enabled = NO;
        identity.toolTip = self.consent;
        [menu addItem:identity];
    }
    [menu addItem:NSMenuItem.separatorItem];
    self.captureStatus = [[NSMenuItem alloc] initWithTitle:@"Select a source to authorize this one capture and send." action:nil keyEquivalent:@""];
    self.captureStatus.enabled = NO;
    [menu addItem:self.captureStatus];
    self.reviewAction = [[NSMenuItem alloc] initWithTitle:@"Review Before Sending" action:@selector(reviewFirst:) keyEquivalent:@""];
    self.reviewAction.target = self;
    [menu addItem:self.reviewAction];
    NSMenuItem *discard = [[NSMenuItem alloc] initWithTitle:@"Stop & Discard" action:@selector(discard:) keyEquivalent:@""];
    discard.target = self;
    [menu addItem:discard];
    [menu addItem:NSMenuItem.separatorItem];
    self.windowAction = [[NSMenuItem alloc] initWithTitle:@"Choose a Window…" action:@selector(chooseWindow:) keyEquivalent:@""];
    self.windowAction.target = self;
    [menu addItem:self.windowAction];
    self.displayAction = [[NSMenuItem alloc] initWithTitle:@"Choose a Display…" action:@selector(chooseDisplay:) keyEquivalent:@""];
    self.displayAction.target = self;
    [menu addItem:self.displayAction];
    NSMenuItem *details = [[NSMenuItem alloc] initWithTitle:@"Capture Details & Permissions…" action:@selector(openDetails:) keyEquivalent:@""];
    details.target = self;
    [menu addItem:details];
    self.captureIndicator.menu = menu;
    [NSWorkspace.sharedWorkspace.notificationCenter addObserver:self selector:@selector(sessionUnavailable:)
        name:NSWorkspaceSessionDidResignActiveNotification object:nil];
    [NSWorkspace.sharedWorkspace.notificationCenter addObserver:self selector:@selector(sessionUnavailable:)
        name:NSWorkspaceScreensDidSleepNotification object:nil];
    [NSDistributedNotificationCenter.defaultCenter addObserver:self selector:@selector(sessionUnavailable:)
        name:@"com.apple.screenIsLocked" object:nil];
    self.timer = [NSTimer scheduledTimerWithTimeInterval:0.25 target:self selector:@selector(tick:) userInfo:nil repeats:YES];
    [NSRunLoop.mainRunLoop addTimer:self.timer forMode:NSRunLoopCommonModes];
    [self chooseSource:nil];
}

- (void)updateStatus:(NSString *)status {
    self.captureStatus.title = status;
    self.status.stringValue = status;
}

- (void)chooseWindow:(id)sender {
    if (atomic_load(&_completed) || _sourceChosen || _loadingSources || _usingPermissionedSources) return;
    self.requestedStyle = SCShareableContentStyleWindow;
    [self.sourcePicker selectItemWithTag:self.requestedStyle];
    [self chooseSource:nil];
}

- (void)chooseDisplay:(id)sender {
    if (atomic_load(&_completed) || _sourceChosen || _loadingSources || _usingPermissionedSources) return;
    self.requestedStyle = SCShareableContentStyleDisplay;
    [self.sourcePicker selectItemWithTag:self.requestedStyle];
    [self chooseSource:nil];
}

- (void)openDetails:(id)sender {
    if (atomic_load(&_completed)) return;
    [self createPanel];
    [self.panel orderFrontRegardless];
    [self showDetails:nil];
}

- (void)createPanel {
    if (self.panel) return;
    self.panel = [[NSPanel alloc] initWithContentRect:NSMakeRect(0, 0, 500, 210)
        styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskNonactivatingPanel
        backing:NSBackingStoreBuffered defer:NO];
    self.panel.title = [@"Capture & Send — " stringByAppendingString:[self.summary componentsSeparatedByString:@"\n"].firstObject ?: @"Lumiverse"];
    self.panel.level = NSFloatingWindowLevel;
    self.panel.hidesOnDeactivate = NO;
    self.panel.releasedWhenClosed = NO;
    self.panel.becomesKeyOnlyIfNeeded = YES;
    self.panel.collectionBehavior = NSWindowCollectionBehaviorCanJoinAllSpaces | NSWindowCollectionBehaviorFullScreenAuxiliary;
    self.panel.delegate = self;
    self.summaryLabel = [NSTextField wrappingLabelWithString:self.summary];
    self.summaryLabel.frame = NSMakeRect(16, 110, 468, 84);
    self.summaryLabel.font = [NSFont systemFontOfSize:12 weight:NSFontWeightMedium];
    self.summaryLabel.toolTip = self.consent;
    [self.panel.contentView addSubview:self.summaryLabel];
    self.detailsPopover = [NSPopover new];
    self.detailsPopover.behavior = NSPopoverBehaviorSemitransient;
    self.detailsPopover.contentSize = NSMakeSize(500, 478);
    NSViewController *detailsController = [NSViewController new];
    detailsController.view = [[NSView alloc] initWithFrame:NSMakeRect(0, 0, 500, 478)];
    self.detailsPopover.contentViewController = detailsController;
    NSScrollView *identityScroll = [[NSScrollView alloc] initWithFrame:NSMakeRect(16, 232, 468, 230)];
    identityScroll.hasVerticalScroller = YES;
    identityScroll.borderType = NSBezelBorder;
    NSTextView *identity = [[NSTextView alloc] initWithFrame:identityScroll.contentView.bounds];
    identity.editable = NO;
    identity.richText = NO;
    identity.selectable = YES;
    identity.verticallyResizable = YES;
    identity.horizontallyResizable = NO;
    identity.autoresizingMask = NSViewWidthSizable;
    identity.maxSize = NSMakeSize(CGFLOAT_MAX, CGFLOAT_MAX);
    identity.textContainer.containerSize = NSMakeSize(identityScroll.contentSize.width, CGFLOAT_MAX);
    identity.textContainer.widthTracksTextView = YES;
    identity.font = [NSFont systemFontOfSize:13];
    identity.string = self.consent;
    identityScroll.documentView = identity;
    [detailsController.view addSubview:identityScroll];
    self.status = [NSTextField wrappingLabelWithString:@"Selecting a source authorizes one capture and send to the destination above. Stop & Discard cancels. Review Before Sending pauses release."];
    self.status.font = [NSFont systemFontOfSize:12];
    self.status.frame = NSMakeRect(16, 56, 468, 50);
    [self.panel.contentView addSubview:self.status];
    self.primary = [NSButton buttonWithTitle:@"Review Before Sending" target:self action:@selector(reviewFirst:)];
    self.primary.frame = NSMakeRect(304, 16, 180, 32);
    [self.panel.contentView addSubview:self.primary];
    self.sourcePicker = [[NSPopUpButton alloc] initWithFrame:NSMakeRect(16, 192, 468, 32) pullsDown:NO];
    [self.sourcePicker addItemWithTitle:@"Entire Display"];
    self.sourcePicker.lastItem.tag = SCShareableContentStyleDisplay;
    [self.sourcePicker addItemWithTitle:@"Window"];
    self.sourcePicker.lastItem.tag = SCShareableContentStyleWindow;
    [self.sourcePicker selectItemWithTag:self.requestedStyle];
    self.sourcePicker.target = self;
    self.sourcePicker.action = @selector(chooseSource:);
    [detailsController.view addSubview:self.sourcePicker];
    self.permissionHelp = [NSTextField wrappingLabelWithString:@""];
    self.permissionHelp.frame = NSMakeRect(16, 96, 468, 90);
    self.permissionHelp.font = [NSFont systemFontOfSize:12];
    [detailsController.view addSubview:self.permissionHelp];
    self.permissionButton = [NSButton buttonWithTitle:@"" target:self action:@selector(screenRecordingAccess:)];
    self.permissionButton.frame = NSMakeRect(16, 56, 468, 32);
    [detailsController.view addSubview:self.permissionButton];
    self.permissionedSources = [[NSPopUpButton alloc] initWithFrame:NSMakeRect(16, 16, 468, 32) pullsDown:NO];
    self.permissionedSources.target = self;
    self.permissionedSources.action = @selector(permissionedSourceChanged:);
    self.permissionedSources.hidden = YES;
    [detailsController.view addSubview:self.permissionedSources];
    [self refreshScreenRecordingAccess];
    NSButton *discardButton = [NSButton buttonWithTitle:@"Stop & Discard" target:self action:@selector(discard:)];
    discardButton.frame = NSMakeRect(16, 16, 128, 32);
    [self.panel.contentView addSubview:discardButton];
    self.detailsButton = [NSButton buttonWithTitle:@"Details…" target:self action:@selector(showDetails:)];
    self.detailsButton.frame = NSMakeRect(152, 16, 100, 32);
    [self.panel.contentView addSubview:self.detailsButton];
    NSRect available = (NSScreen.mainScreen ?: NSScreen.screens.firstObject).visibleFrame;
    [self.panel setFrameTopLeftPoint:NSMakePoint(NSMaxX(available) - self.panel.frame.size.width - 16, NSMaxY(available) - 16)];
    if (_sourceChosen) {
        self.sourcePicker.enabled = NO;
        self.permissionButton.hidden = YES;
        self.permissionHelp.hidden = YES;
    }
    [self updateStatus:self.captureStatus.title];
}

- (void)showDetails:(id)sender {
    if (atomic_load(&_completed)) return;
    if (self.detailsPopover.shown) { [self.detailsPopover close]; return; }
    if (!_sourceChosen) {
        [SCContentSharingPicker.sharedPicker removeObserver:self];
        SCContentSharingPicker.sharedPicker.active = NO;
        self.primary.title = @"Open macOS Picker…";
        self.primary.action = @selector(chooseSource:);
        self.primary.enabled = !_loadingSources && (!_usingPermissionedSources || self.permissionedSources.selectedItem.representedObject != nil);
        self.sourcePicker.enabled = !_loadingSources;
        self.permissionButton.enabled = !_loadingSources;
        self.permissionButton.hidden = NO;
        self.permissionHelp.hidden = NO;
    }
    [self.detailsPopover showRelativeToRect:self.detailsButton.bounds ofView:self.detailsButton preferredEdge:NSRectEdgeMinY];
}

- (void)reviewFirst:(id)sender {
    if (atomic_load(&_completed)) return;
    self.automaticShare = NO;
    self.reviewAction.state = NSControlStateValueOn;
    self.reviewAction.enabled = NO;
    self.primary.title = @"Review at finish";
    self.primary.enabled = NO;
    [self updateStatus:@"Review is on for this capture only. Inspect it and choose Share when ready."];
}

- (void)refreshScreenRecordingAccess {
    if (_sourceChosen || _usingPermissionedSources || _loadingSources) return;
    BOOL granted = CGPreflightScreenCaptureAccess();
    self.permissionButton.title = granted ? @"Choose From Permissioned Source List…"
        : (_permissionRequestAttempted ? @"Open Screen Recording Settings…" : @"Grant Screen Recording Access…");
    self.permissionHelp.stringValue = granted
        ? @"macOS Screen & System Audio Recording access is granted. Use the macOS picker below, or the permissioned source list if the overlay cannot select another app or the entire desktop. Nothing is captured until you choose a source. Audio is never recorded."
        : @"The macOS picker can authorize one source without app-wide access. If other apps or displays are missing, grant Screen & System Audio Recording access below. Audio is never recorded. A source must be selected for every request.";
    if (!granted && _permissionRequestAttempted) {
        self.permissionHelp.stringValue = @"Enable the requesting app in System Settings → Privacy & Security → Screen & System Audio Recording. Restart the desktop client if macOS asks, then request a new capture. Development executables may be attributed to Terminal or your editor; prefer a bundled .app rather than granting that launcher broader access. No capture resumes automatically.";
    }
}

- (void)screenRecordingAccess:(id)sender {
    if (atomic_load(&_completed) || _sourceChosen || _loadingSources) return;
    if (NSProcessInfo.processInfo.systemUptime >= self.expiresAt) { [self finishOutcome:2]; return; }
    if (_usingPermissionedSources) {
        _usingPermissionedSources = NO;
        self.permissionedContent = nil;
        [self.permissionedSources removeAllItems];
        self.permissionedSources.hidden = YES;
        self.sourcePicker.hidden = NO;
        self.sourcePicker.enabled = YES;
        self.primary.title = @"Choose Source…";
        self.primary.enabled = YES;
        [self refreshScreenRecordingAccess];
        return;
    }
    if (!CGPreflightScreenCaptureAccess()) {
        if (_permissionRequestAttempted) {
            [NSWorkspace.sharedWorkspace openURL:[NSURL URLWithString:@"x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"]];
            return;
        }
        _permissionRequestAttempted = YES;
        self.primary.enabled = NO;
        self.permissionButton.enabled = NO;
        BOOL granted = CGRequestScreenCaptureAccess();
        NSLog(@"[Lumiverse capture] owner requested screen-recording access: result=%d preflight=%d", granted, CGPreflightScreenCaptureAccess());
        if (atomic_load(&_completed)) return;
        if (NSProcessInfo.processInfo.systemUptime >= self.expiresAt) { [self finishOutcome:2]; return; }
        self.primary.enabled = YES;
        self.permissionButton.enabled = YES;
        if (!CGPreflightScreenCaptureAccess()) { [self refreshScreenRecordingAccess]; return; }
    }
    _loadingSources = YES;
    self.primary.enabled = NO;
    self.permissionButton.enabled = NO;
    self.sourcePicker.enabled = NO;
    self.permissionHelp.stringValue = @"Loading the native source list using your app-wide Screen Recording permission. Source names remain on this device; nothing has been captured.";
    [SCShareableContent getShareableContentExcludingDesktopWindows:YES onScreenWindowsOnly:YES completionHandler:^(SCShareableContent *content, NSError *error) {
        dispatch_async(dispatch_get_main_queue(), ^{
            if (atomic_load(&self->_completed)) return;
            self->_loadingSources = NO;
            if (!CGPreflightScreenCaptureAccess()) { [self finishOutcome:1]; return; }
            if (error || !content) { [self captureFailed:error]; return; }
            self.permissionedContent = content;
            [self.permissionedSources removeAllItems];
            [self.permissionedSources addItemWithTitle:@"Select a display or another app's window…"];
            NSUInteger displayIndex = 0;
            for (SCDisplay *display in content.displays) {
                if (displayIndex >= 16) break;
                ++displayIndex;
                [self.permissionedSources addItemWithTitle:[NSString stringWithFormat:@"Entire Display %lu — %ld × %ld", displayIndex, display.width, display.height]];
                self.permissionedSources.lastItem.representedObject = display;
            }
            for (SCWindow *window in content.windows) {
                if (self.permissionedSources.numberOfItems >= 257) break;
                if (!window.isOnScreen || window.windowLayer != 0 || !window.owningApplication
                    || window.owningApplication.processID == getpid() || CGRectIsEmpty(window.frame)) continue;
                NSString *title = [NSString stringWithFormat:@"Window %ld — %@ — %@", self.permissionedSources.numberOfItems - displayIndex,
                    window.owningApplication.applicationName, window.title ?: @"Untitled window"];
                if (title.length > 160) title = [title substringToIndex:160];
                [self.permissionedSources addItemWithTitle:title];
                self.permissionedSources.lastItem.representedObject = window;
            }
            self->_usingPermissionedSources = YES;
            self.sourcePicker.hidden = YES;
            self.permissionedSources.hidden = NO;
            self.permissionButton.enabled = YES;
            self.permissionButton.title = @"Use macOS Picker Instead";
            self.primary.title = @"Capture Selected Source";
            self.permissionHelp.stringValue = @"Select a display or another app's window, then Capture Selected Source to authorize this one capture and send. The extension cannot choose or see this list. Review Before Sending pauses release; Stop & Discard cancels.";
            NSLog(@"[Lumiverse capture] permissioned source list: display-count=%lu source-count=%ld", content.displays.count, self.permissionedSources.numberOfItems - 1);
        });
    }];
}

- (void)permissionedSourceChanged:(id)sender {
    if (atomic_load(&_completed) || _sourceChosen || !_usingPermissionedSources) return;
    self.primary.enabled = self.permissionedSources.selectedItem.representedObject != nil;
}

- (void)chooseSource:(id)sender {
    if (atomic_load(&_completed) || _sourceChosen) return;
    if (_loadingSources) return;
    [self.detailsPopover close];
    if (_usingPermissionedSources) {
        if (!CGPreflightScreenCaptureAccess()) { [self finishOutcome:1]; return; }
        id source = self.permissionedSources.selectedItem.representedObject;
        SCContentFilter *filter = nil;
        if ([source isKindOfClass:SCDisplay.class]) {
            NSMutableArray<SCWindow *> *excluded = [NSMutableArray new];
            for (SCWindow *window in self.permissionedContent.windows) {
                if (window.owningApplication.processID == getpid() || window.windowID == self.panel.windowNumber) [excluded addObject:window];
            }
            self.requestedStyle = SCShareableContentStyleDisplay;
            filter = [[SCContentFilter alloc] initWithDisplay:source excludingWindows:excluded];
        } else if ([source isKindOfClass:SCWindow.class]) {
            self.requestedStyle = SCShareableContentStyleWindow;
            filter = [[SCContentFilter alloc] initWithDesktopIndependentWindow:source];
        }
        if (!filter) return;
        [self captureFilter:filter];
        return;
    }
    SCShareableContentStyle contentStyle = self.sourcePicker ? self.sourcePicker.selectedTag : self.requestedStyle;
    if (contentStyle != SCShareableContentStyleWindow && contentStyle != SCShareableContentStyleDisplay) {
        [self finishOutcome:4]; return;
    }
    self.primary.enabled = NO;
    self.sourcePicker.enabled = NO;
    self.permissionButton.enabled = NO;
    self.permissionButton.hidden = YES;
    self.permissionHelp.hidden = YES;
    self.requestedStyle = contentStyle;
    [self.panel orderOut:nil];
    SCContentSharingPicker *picker = SCContentSharingPicker.sharedPicker;
    [picker removeObserver:self];
    picker.active = NO;
    SCContentSharingPickerConfiguration *configuration = [SCContentSharingPickerConfiguration new];
    configuration.allowedPickerModes = SCContentSharingPickerModeSingleDisplay | SCContentSharingPickerModeSingleWindow;
    configuration.allowsChangingSelectedContent = NO;
    if (self.panel.windowNumber > 0) configuration.excludedWindowIDs = @[@(self.panel.windowNumber)];
    if (NSBundle.mainBundle.bundleIdentifier) configuration.excludedBundleIDs = @[NSBundle.mainBundle.bundleIdentifier];
    picker.defaultConfiguration = configuration;
    picker.maximumStreamCount = @1;
    [picker addObserver:self];
    picker.active = YES;
    [picker presentPickerUsingContentStyle:contentStyle];
    if (self.automaticShare) {
        self.primary.title = @"Review Before Sending";
        self.primary.action = @selector(reviewFirst:);
        self.primary.enabled = YES;
    }
}

- (void)discard:(id)sender { [self finishOutcome:2]; }
- (void)sessionUnavailable:(NSNotification *)notification {
    dispatch_async(dispatch_get_main_queue(), ^{ [self finishOutcome:2]; });
}
- (BOOL)windowShouldClose:(NSWindow *)sender { [self finishOutcome:2]; return NO; }

- (void)tick:(NSTimer *)timer {
    if (atomic_load(&_completed)) return;
    NSTimeInterval now = NSProcessInfo.processInfo.systemUptime;
    if (now >= self.expiresAt) { [self finishOutcome:2]; return; }
    if (_usingPermissionedSources && !CGPreflightScreenCaptureAccess()) { [self finishOutcome:1]; return; }
    [self refreshScreenRecordingAccess];
    if (self.outputURL) {
        NSNumber *size = [NSFileManager.defaultManager attributesOfItemAtPath:self.outputURL.path error:nil][NSFileSize];
        if (size.unsignedLongLongValue > self.maximumBytes) { [self finishOutcome:4]; return; }
    }
    if (self.recordStartedAt > 0 && !self.playerView) {
        NSTimeInterval elapsed = now - self.recordStartedAt;
        [self updateStatus:[NSString stringWithFormat:@"Recording — %.1f / %llu seconds. No audio. Stop & Discard cancels.", MIN(elapsed, self.seconds), self.seconds]];
        self.captureIndicator.button.title = [NSString stringWithFormat:@" %.0fs", ceil(MAX(0, self.seconds - elapsed))];
        if (elapsed >= self.seconds) [self stopRecording];
    }
}

- (void)contentSharingPicker:(SCContentSharingPicker *)picker didCancelForStream:(SCStream *)stream {
    dispatch_async(dispatch_get_main_queue(), ^{ [self finishOutcome:2]; });
}
- (void)contentSharingPickerStartDidFailWithError:(NSError *)error {
    dispatch_async(dispatch_get_main_queue(), ^{ [self captureFailed:error]; });
}

- (void)contentSharingPicker:(SCContentSharingPicker *)picker didUpdateWithFilter:(SCContentFilter *)filter forStream:(SCStream *)stream {
    dispatch_async(dispatch_get_main_queue(), ^{ [self captureFilter:filter]; });
}

- (void)captureFailed:(NSError *)error {
    if (atomic_load(&_completed)) return;
    NSLog(@"[Lumiverse capture] native capture error: domain=%@ code=%ld screen-recording-access=%d", error.domain, error.code, CGPreflightScreenCaptureAccess());
    BOOL denied = [error.domain isEqualToString:SCStreamErrorDomain] && error.code == SCStreamErrorUserDeclined;
    [self finishOutcome:denied ? 1 : 4];
}

- (void)captureFilter:(SCContentFilter *)filter {
    if (atomic_load(&_completed)) return;
    if (_sourceChosen) { [self finishOutcome:2]; return; }
    if (NSProcessInfo.processInfo.systemUptime >= self.expiresAt) { [self finishOutcome:2]; return; }
    if (_usingPermissionedSources && !CGPreflightScreenCaptureAccess()) { [self finishOutcome:1]; return; }
    NSLog(@"[Lumiverse capture] source: requested-style=%ld selected-style=%ld permissioned-list=%d", self.requestedStyle, filter.style, _usingPermissionedSources);
    if (!filter || (filter.style != SCShareableContentStyleDisplay && filter.style != SCShareableContentStyleWindow)
        || (_usingPermissionedSources && filter.style != self.requestedStyle)) { [self finishOutcome:4]; return; }
    _sourceChosen = YES;
    self.windowAction.enabled = NO;
    self.displayAction.enabled = NO;
    self.primary.enabled = NO;
    self.primary.title = @"Review at finish";
    if (self.automaticShare) {
        self.primary.title = @"Review Before Sending";
        self.primary.action = @selector(reviewFirst:);
        self.primary.enabled = YES;
    }
    self.sourcePicker.enabled = NO;
    self.permissionButton.hidden = YES;
    self.permissionHelp.hidden = YES;
    self.permissionedSources.hidden = YES;
    self.permissionedContent = nil;
    [self.permissionedSources removeAllItems];
    [self.panel orderOut:nil];
    CGSize size = filter.contentRect.size;
    double scale = filter.pointPixelScale;
    if (!isfinite(size.width) || !isfinite(size.height) || !isfinite(scale) || size.width <= 0 || size.height <= 0 || scale <= 0) {
        [self finishOutcome:4]; return;
    }
    double pixelWidth = size.width * scale;
    double pixelHeight = size.height * scale;
    if (!isfinite(pixelWidth) || !isfinite(pixelHeight)) { [self finishOutcome:4]; return; }
    double ratio = MIN(1.0, MIN(1920.0 / pixelWidth, 1080.0 / pixelHeight));
    self.width = MAX(2, ((uint32_t)(pixelWidth * ratio) / 2) * 2);
    self.height = MAX(2, ((uint32_t)(pixelHeight * ratio) / 2) * 2);
    if ((uint64_t)self.width * self.height > self.maximumPixels) { [self finishOutcome:4]; return; }
    SCStreamConfiguration *configuration = [SCStreamConfiguration new];
    configuration.width = self.width;
    configuration.height = self.height;
    configuration.minimumFrameInterval = CMTimeMake(1, 30);
    configuration.queueDepth = 3;
    configuration.pixelFormat = kCVPixelFormatType_32BGRA;
    configuration.showsCursor = YES;
    configuration.capturesAudio = NO;
    if (@available(macOS 15.0, *)) configuration.captureMicrophone = NO;
    if (self.video) {
        [self startRecordingWithFilter:filter configuration:configuration];
    } else {
        [SCScreenshotManager captureImageWithFilter:filter configuration:configuration completionHandler:^(CGImageRef image, NSError *error) {
            if (image) CGImageRetain(image);
            dispatch_async(dispatch_get_main_queue(), ^{
                if (!atomic_load(&self->_completed)) {
                    if (error || !image) { [self captureFailed:error]; }
                    else {
                        NSBitmapImageRep *bitmap = [[NSBitmapImageRep alloc] initWithCGImage:image];
                        NSData *encoded = [bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
                        if (!encoded.length || encoded.length > self.maximumBytes) [self finishOutcome:4];
                        else {
                            self.imageData = [encoded mutableCopy];
                            self.imageView = [[NSImageView alloc] initWithFrame:NSMakeRect(20, 120, 700, 235)];
                            self.imageView.imageScaling = NSImageScaleProportionallyUpOrDown;
                            self.imageView.image = [[NSImage alloc] initWithCGImage:image size:NSZeroSize];
                            [self.panel.contentView addSubview:self.imageView];
                            [self showReview];
                        }
                    }
                }
                if (image) CGImageRelease(image);
            });
        }];
    }
}

- (void)showReview {
    SCContentSharingPicker.sharedPicker.active = NO;
    [SCContentSharingPicker.sharedPicker removeObserver:self];
    if (self.automaticShare) { [self share:nil]; return; }
    [self createPanel];
    NSRect frame = self.panel.frame;
    CGFloat oldHeight = frame.size.height;
    [self.panel setContentSize:NSMakeSize(500, 480)];
    frame = self.panel.frame;
    frame.origin.y -= frame.size.height - oldHeight;
    [self.panel setFrame:frame display:YES];
    self.summaryLabel.frame = NSMakeRect(16, 378, 468, 86);
    self.status.frame = NSMakeRect(16, 324, 468, 48);
    self.imageView.frame = NSMakeRect(16, 64, 468, 250);
    self.playerView.frame = NSMakeRect(16, 64, 468, 250);
    if (self.imageView) [self.panel.contentView addSubview:self.imageView];
    if (self.playerView) [self.panel.contentView addSubview:self.playerView];
    [self updateStatus:@"Review locally. Share sends this one capture to the destination above. Details includes the instance, account and full request."];
    self.primary.title = @"Share This Capture";
    self.primary.action = @selector(share:);
    self.primary.enabled = YES;
    self.sourcePicker.hidden = YES;
    [self.panel orderFrontRegardless];
}

- (void)share:(id)sender {
    if (atomic_load(&_completed) || !_sourceChosen) return;
    if (NSProcessInfo.processInfo.systemUptime >= self.expiresAt) { [self finishOutcome:2]; return; }
    if (_usingPermissionedSources && !CGPreflightScreenCaptureAccess()) { [self finishOutcome:1]; return; }
    [self finishOutcome:0];
}

- (void)startRecordingWithFilter:(SCContentFilter *)filter configuration:(SCStreamConfiguration *)configuration {
    if (!(lumiverse_capture_capabilities() & 2)) { [self finishOutcome:3]; return; }
    NSString *template = [NSTemporaryDirectory() stringByAppendingPathComponent:[NSString stringWithFormat:@"lumiverse-capture-%d-XXXXXX", getpid()]];
    char *path = strdup(template.fileSystemRepresentation);
    char *directory = mkdtemp(path);
    if (!directory) { free(path); [self finishOutcome:4]; return; }
    self.directory = [NSURL fileURLWithFileSystemRepresentation:directory isDirectory:YES relativeToURL:nil];
    free(path);
    self.outputURL = [self.directory URLByAppendingPathComponent:@"capture.mp4"];
    NSError *error = nil;
    self.writer = [[AVAssetWriter alloc] initWithURL:self.outputURL fileType:AVFileTypeMPEG4 error:&error];
    NSDictionary *settings = @{
        AVVideoCodecKey: AVVideoCodecTypeH264,
        AVVideoWidthKey: @(self.width), AVVideoHeightKey: @(self.height),
        AVVideoEncoderSpecificationKey: @{
            (__bridge NSString *)kVTVideoEncoderSpecification_EnableHardwareAcceleratedVideoEncoder: @YES,
            (__bridge NSString *)kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder: @YES,
        },
        AVVideoCompressionPropertiesKey: @{
            AVVideoAverageBitRateKey: @4000000,
            AVVideoExpectedSourceFrameRateKey: @30,
            AVVideoMaxKeyFrameIntervalKey: @30,
            AVVideoAllowFrameReorderingKey: @NO,
            AVVideoProfileLevelKey: AVVideoProfileLevelH264MainAutoLevel,
        }
    };
    self.input = [AVAssetWriterInput assetWriterInputWithMediaType:AVMediaTypeVideo outputSettings:settings];
    self.input.expectsMediaDataInRealTime = YES;
    if (error || !self.writer || ![self.writer canAddInput:self.input]) { [self finishOutcome:4]; return; }
    [self.writer addInput:self.input];
    if (![self.writer startWriting]) { [self finishOutcome:4]; return; }
    chmod(self.outputURL.fileSystemRepresentation, 0600);
    self.stream = [[SCStream alloc] initWithFilter:filter configuration:configuration delegate:self];
    if (![self.stream addStreamOutput:self type:SCStreamOutputTypeScreen sampleHandlerQueue:self.outputQueue error:&error]) {
        [self captureFailed:error]; return;
    }
    [self.stream startCaptureWithCompletionHandler:^(NSError *error) {
        dispatch_async(dispatch_get_main_queue(), ^{
            if (atomic_load(&self->_completed)) return;
            if (error) { [self captureFailed:error]; return; }
            self.recordStartedAt = NSProcessInfo.processInfo.systemUptime;
            [self updateStatus:@"Recording selected source with hardware H.264. No audio."];
        });
    }];
}

- (void)stream:(SCStream *)stream didOutputSampleBuffer:(CMSampleBufferRef)buffer ofType:(SCStreamOutputType)type {
    if (atomic_load(&_cancelled) || _finishing || type != SCStreamOutputTypeScreen || !CMSampleBufferIsValid(buffer)) return;
    CFArrayRef attachments = CMSampleBufferGetSampleAttachmentsArray(buffer, false);
    if (!attachments || !CFArrayGetCount(attachments)) return;
    NSDictionary *information = (__bridge NSDictionary *)CFArrayGetValueAtIndex(attachments, 0);
    NSNumber *status = information[SCStreamFrameInfoStatus];
    if (status.integerValue == SCFrameStatusBlank || status.integerValue == SCFrameStatusSuspended || status.integerValue == SCFrameStatusStopped) {
        dispatch_async(dispatch_get_main_queue(), ^{ [self finishOutcome:2]; }); return;
    }
    if (!status || status.integerValue != SCFrameStatusComplete || !self.input.readyForMoreMediaData) return;
    CMTime timestamp = CMSampleBufferGetPresentationTimeStamp(buffer);
    if (!CMTIME_IS_NUMERIC(timestamp)) return;
    if (!_sessionStarted) {
        _firstTime = timestamp;
        [self.writer startSessionAtSourceTime:timestamp];
        _sessionStarted = YES;
    }
    if (CMTimeGetSeconds(CMTimeSubtract(timestamp, _firstTime)) >= self.seconds) return;
    if (![self.input appendSampleBuffer:buffer]) {
        dispatch_async(dispatch_get_main_queue(), ^{ [self finishOutcome:4]; }); return;
    }
    _lastTime = timestamp;
    if (_lastBuffer) CFRelease(_lastBuffer);
    _lastBuffer = (CMSampleBufferRef)CFRetain(buffer);
}

- (void)stream:(SCStream *)stream didStopWithError:(NSError *)error {
    dispatch_async(dispatch_get_main_queue(), ^{
        if ([error.domain isEqualToString:SCStreamErrorDomain] && error.code == SCStreamErrorUserStopped) [self finishOutcome:2];
        else [self captureFailed:error];
    });
}

- (void)stopRecording {
    if (self.recordStartedAt == 0 || atomic_load(&_completed)) return;
    self.duration = MIN(self.seconds, NSProcessInfo.processInfo.systemUptime - self.recordStartedAt);
    self.recordStartedAt = 0;
    [self updateStatus:@"Finishing the recording locally. Nothing has been uploaded."];
    [self.stream stopCaptureWithCompletionHandler:^(NSError *error) {
        dispatch_async(self.outputQueue, ^{
            if (atomic_load(&self->_cancelled)) return;
            self->_finishing = YES;
            if (error || !self->_sessionStarted || !self->_lastBuffer || self.duration <= 0) {
                dispatch_async(dispatch_get_main_queue(), ^{ [self finishOutcome:4]; }); return;
            }
            CMTime end = CMTimeAdd(self->_firstTime, CMTimeMakeWithSeconds(self.duration, 60000));
            CMTime finalTime = CMTimeSubtract(end, CMTimeMake(1, 30));
            if (CMTimeCompare(finalTime, self->_lastTime) > 0 && self.input.readyForMoreMediaData) {
                CMSampleTimingInfo timing = {CMTimeMake(1, 30), finalTime, kCMTimeInvalid};
                CMSampleBufferRef repeated = NULL;
                if (CMSampleBufferCreateCopyWithNewTiming(kCFAllocatorDefault, self->_lastBuffer, 1, &timing, &repeated) == noErr) {
                    [self.input appendSampleBuffer:repeated];
                    CFRelease(repeated);
                }
            }
            [self.writer endSessionAtSourceTime:end];
            [self.input markAsFinished];
            [self.writer finishWritingWithCompletionHandler:^{
                dispatch_async(dispatch_get_main_queue(), ^{
                    if (atomic_load(&self->_completed)) return;
                    NSNumber *size = [NSFileManager.defaultManager attributesOfItemAtPath:self.outputURL.path error:nil][NSFileSize];
                    if (self.writer.status != AVAssetWriterStatusCompleted || !size || size.unsignedLongLongValue == 0 || size.unsignedLongLongValue > self.maximumBytes) {
                        [self finishOutcome:4]; return;
                    }
                    AVURLAsset *asset = [AVURLAsset URLAssetWithURL:self.outputURL options:@{AVURLAssetPreferPreciseDurationAndTimingKey: @YES}];
                    self.validationAsset = asset;
                    [asset loadTracksWithMediaType:AVMediaTypeAudio completionHandler:^(NSArray<AVAssetTrack *> *tracks, NSError *error) {
                        dispatch_async(self.outputQueue, ^{
                            if (atomic_load(&self->_cancelled)) return;
                            double duration = error ? NAN : CMTimeGetSeconds(asset.duration);
                            dispatch_async(dispatch_get_main_queue(), ^{
                                if (atomic_load(&self->_completed)) return;
                                self.validationAsset = nil;
                                if (error || !tracks || tracks.count != 0 || !isfinite(duration) || duration <= 0 || duration > self.seconds) {
                                    [self finishOutcome:4]; return;
                                }
                                self.duration = duration;
                                self.playerView = [[AVPlayerView alloc] initWithFrame:NSMakeRect(20, 120, 700, 235)];
                                self.playerView.player = [AVPlayer playerWithURL:self.outputURL];
                                self.playerView.controlsStyle = AVPlayerViewControlsStyleInline;
                                [self.panel.contentView addSubview:self.playerView];
                                [self showReview];
                            });
                        });
                    }];
                });
            }];
        });
    }];
}

- (void)finishOutcome:(uint32_t)outcome {
    if (atomic_exchange(&_completed, true)) return;
    atomic_store(&_cancelled, true);
    [self.timer invalidate];
    self.timer = nil;
    self.captureIndicator.menu = nil;
    if (self.captureIndicator) [NSStatusBar.systemStatusBar removeStatusItem:self.captureIndicator];
    self.captureIndicator = nil;
    [NSWorkspace.sharedWorkspace.notificationCenter removeObserver:self];
    [NSDistributedNotificationCenter.defaultCenter removeObserver:self];
    SCContentSharingPicker.sharedPicker.active = NO;
    [SCContentSharingPicker.sharedPicker removeObserver:self];
    [self.playerView.player pause];
    [self.validationAsset cancelLoading];
    self.validationAsset = nil;
    self.playerView.player = nil;
    self.imageView.image = nil;
    self.permissionedContent = nil;
    [self.permissionedSources removeAllItems];
    self.panel.delegate = nil;
    [self.detailsPopover close];
    [self.panel close];
    void (^cleanup)(void) = ^{
        dispatch_async(self.outputQueue, ^{
            if (self.stream) [self.stream removeStreamOutput:self type:SCStreamOutputTypeScreen error:nil];
            if (self.writer.status == AVAssetWriterStatusWriting) [self.writer cancelWriting];
            dispatch_async(dispatch_get_main_queue(), ^{
                NSMutableData *data = self.imageData;
                uint32_t finalOutcome = outcome;
                if (outcome == 0 && self.video) {
                    NSDictionary *attributes = [NSFileManager.defaultManager attributesOfItemAtPath:self.outputURL.path error:nil];
                    NSUInteger size = [attributes[NSFileSize] unsignedIntegerValue];
                    if (size == 0 || size > self.maximumBytes) finalOutcome = 4;
                    else data = [NSMutableData dataWithContentsOfURL:self.outputURL];
                }
                if (finalOutcome == 0 && (!data.length || data.length > self.maximumBytes)) finalOutcome = 4;
                if (self.directory) [NSFileManager.defaultManager removeItemAtURL:self.directory error:nil];
                CaptureCallback callback = self.callback;
                self.callback = NULL;
                if (currentCapture == self) currentCapture = nil;
                callback(self.context, finalOutcome, finalOutcome == 0 ? data.bytes : NULL,
                    finalOutcome == 0 ? data.length : 0, self.width, self.height, self.video ? self.duration : 0);
                if (data.length) [data resetBytesInRange:NSMakeRange(0, data.length)];
                self.imageData = nil;
                self.stream = nil;
                self.writer = nil;
                self.input = nil;
            });
        });
    };
    if (self.stream) [self.stream stopCaptureWithCompletionHandler:^(NSError *error) { (void)error; cleanup(); }];
    else cleanup();
}
@end

void lumiverse_capture_begin(const char *request_id, const char *consent, const char *summary, bool video, uint64_t seconds,
    size_t max_bytes, uint64_t max_pixels, uint64_t remaining_ms, CaptureCallback callback, void *context) {
    if (@available(macOS 14.0, *)) {
        if (currentCapture || remaining_ms == 0 || remaining_ms > 120000 || max_bytes == 0 || max_pixels == 0
            || max_pixels > 16777216 || max_bytes > (video ? 33554432 : 8388608)
            || (video && (!(lumiverse_capture_capabilities() & 2) || seconds == 0 || seconds > 30))) {
            callback(context, 3, NULL, 0, 0, 0, 0); return;
        }
        LumiverseCapture *capture = [LumiverseCapture new];
        capture.requestID = [NSString stringWithUTF8String:request_id];
        capture.consent = [NSString stringWithUTF8String:consent];
        capture.summary = [NSString stringWithUTF8String:summary];
        capture.automaticShare = YES;
        capture.video = video;
        capture.seconds = seconds;
        capture.maximumBytes = max_bytes;
        capture.maximumPixels = max_pixels;
        capture.expiresAt = NSProcessInfo.processInfo.systemUptime + remaining_ms / 1000.0;
        capture.callback = callback;
        capture.context = context;
        currentCapture = capture;
        [capture start];
    } else callback(context, 3, NULL, 0, 0, 0, 0);
}

void lumiverse_capture_cancel(const char *request_id) {
    if (@available(macOS 14.0, *)) {
        if ([currentCapture.requestID isEqualToString:[NSString stringWithUTF8String:request_id]]) [currentCapture finishOutcome:2];
    }
}

void lumiverse_capture_shutdown(void) {
    if (@available(macOS 14.0, *)) {
        if (currentCapture.directory) [NSFileManager.defaultManager removeItemAtURL:currentCapture.directory error:nil];
        [currentCapture finishOutcome:2];
    }
}
