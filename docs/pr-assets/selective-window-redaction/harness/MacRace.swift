// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import Cocoa
let app=NSApplication.shared;app.setActivationPolicy(.accessory)
var window:NSWindow?;var ticks=0
let timer=Timer.scheduledTimer(withTimeInterval:0.05,repeats:true){_ in
 ticks += 1
 if ticks>1200 {app.terminate(nil);return}
 if ticks%3==0 {window?.close();window=nil;return}
 if window == nil {let w=NSWindow(contentRect:NSRect(x:400,y:200,width:350,height:300),styleMask:[.titled],backing:.buffered,defer:false);w.isReleasedWhenClosed=false;w.title="PrivacyBlocked transient";w.backgroundColor = .magenta;window=w}
 window?.setFrameOrigin(NSPoint(x:400+ticks%80,y:200));window?.orderFrontRegardless()
}
app.run()
