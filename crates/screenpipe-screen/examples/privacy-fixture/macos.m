// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

#import <Cocoa/Cocoa.h>
#import <CoreGraphics/CoreGraphics.h>
@interface Fixture : NSObject
@property(strong) NSWindow *allowed;
@property(strong) NSWindow *blocked;
@property(strong) NSString *root;
@property(strong) NSString *observed;
@end
@implementation Fixture
-(void)tick:(NSTimer*)timer {
 if (getenv("PRIVACY_ANIMATE") && self.blocked) {
  double phase = NSDate.timeIntervalSinceReferenceDate;
  [self.blocked setFrameOrigin:NSMakePoint(420 + 70 * sin(phase * 8), 250 + 50 * cos(phase * 8))];
  if (((int)(phase * 8)) % 2 == 0) [self.blocked orderFrontRegardless];
  else [self.allowed orderFrontRegardless];
 }
 NSString *value=[NSString stringWithContentsOfFile:[self.root stringByAppendingPathComponent:@"resolved"] encoding:NSUTF8StringEncoding error:nil];
 if(value.length && ![value isEqual:self.observed]) {
  self.observed=value;
  [self.blocked close];
  self.blocked=[[NSWindow alloc] initWithContentRect:NSMakeRect(420,250,350,300) styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
  self.blocked.releasedWhenClosed=NO;
  self.blocked.title=@"PrivacyBlocked";
  self.blocked.backgroundColor=[NSColor colorWithRed:1 green:0 blue:1 alpha:1];
  [self.blocked orderFrontRegardless];
  [self.allowed makeKeyWindow];
  printf("blocked after resolution %s\n",value.UTF8String);fflush(stdout);
 }
}
@end
int main(int argc,char**argv) { @autoreleasepool {
 NSApplication *app=NSApplication.sharedApplication;
 [app setActivationPolicy:NSApplicationActivationPolicyRegular];
 Fixture *f=[Fixture new];f.root=[NSString stringWithUTF8String:argv[1]];
 f.allowed=[[NSWindow alloc] initWithContentRect:NSMakeRect(80,100,500,500) styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
 f.allowed.title=@"PrivacyAllowed";
 f.allowed.backgroundColor=[NSColor colorWithRed:0 green:1 blue:1 alpha:1];
 [f.allowed makeKeyAndOrderFront:nil];
 [app activateIgnoringOtherApps:YES];
 [NSTimer scheduledTimerWithTimeInterval:0.02 target:f selector:@selector(tick:) userInfo:nil repeats:YES];
 printf("monitor=%u\n",CGMainDisplayID());fflush(stdout);
 [app run];
}return 0;}
