// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import Cocoa
import CoreGraphics
let app=NSApplication.shared
app.setActivationPolicy(.regular)
let root=FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("redaction")
let names=["Browser","Editor","Notes","Terminal","Private"]
let positions=[NSRect(x:20,y:520,width:470,height:380),NSRect(x:550,y:520,width:470,height:380),NSRect(x:1080,y:520,width:470,height:380),NSRect(x:100,y:80,width:620,height:380),NSRect(x:880,y:80,width:620,height:380)]
var wins:[NSWindow]=[]
for i in 0..<5 {
 let w=NSWindow(contentRect:positions[i],styleMask:[.titled,.closable,.resizable,.miniaturizable],backing:.buffered,defer:false)
 w.isReleasedWhenClosed=false;w.backgroundColor=i==4 ? .magenta : .cyan
 let label=NSTextField(labelWithString:names[i]+"\n"+(i==4 ? "EXCLUDED" : "ALLOWED"));label.font=NSFont.systemFont(ofSize:28);label.textColor = .black;label.frame=NSRect(x:30,y:100,width:400,height:130);w.contentView!.addSubview(label);wins.append(w)
}
func apply(_ name:String) {
 for (i,w) in wins.enumerated() {if w.isMiniaturized {w.deminiaturize(nil)};w.level = .normal;w.alphaValue=1;w.title=(i==4 ? "PrivacyBlocked " : "PrivacyAllowed ")+names[i];w.setFrame(positions[i],display:true);w.orderFrontRegardless()}
 switch name {
 case "no_excluded":wins[4].orderOut(nil)
 case "minimized":wins[4].miniaturize(nil)
 case "offscreen":wins[4].setFrameOrigin(NSPoint(x:1700,y:200))
 case "excluded_front","excluded_behind","transparent_front","small","blank_title":
  wins[4].setFrame(NSRect(x:400,y:150,width:850,height:650),display:true);wins[0].setFrame(NSRect(x:850,y:80,width:650,height:420),display:true);wins[4].orderFrontRegardless()
  if name != "excluded_front" {wins[0].orderFrontRegardless()}
  if name == "transparent_front" {wins[0].alphaValue=0.55}
  if name == "blank_title" {wins[0].title=""}
  if name == "small" {for w in wins[1...3] {w.orderOut(nil)};wins[4].setFrame(NSScreen.main!.frame,display:true);wins[0].setFrame(NSRect(x:50,y:100,width:130,height:85),display:true);wins[0].orderFrontRegardless()}
 case "all_excluded":for w in wins {w.title="PrivacyBlocked secret"}
 case "secondary", "second_allowed":
  if let screen=NSScreen.screens.last, NSScreen.screens.count>1 {wins[4].setFrame(NSRect(x:screen.frame.minX+300,y:screen.frame.minY+180,width:550,height:400),display:true);if name == "second_allowed" {wins[0].setFrame(NSRect(x:screen.frame.minX+80,y:screen.frame.minY+250,width:600,height:400),display:true);wins[0].orderFrontRegardless()}}
 case "spanning":wins[4].setFrame(NSRect(x:1450,y:250,width:700,height:400),display:true)
 case "fully_occluded":wins[0].setFrame(NSRect(x:800,y:80,width:700,height:500),display:true);wins[4].setFrame(NSRect(x:900,y:150,width:450,height:300),display:true);wins[0].orderFrontRegardless()
 default:break
 }
 app.activate(ignoringOtherApps:true);wins[0].makeKey()
 let state:[String:Any] = ["case":name,"monitor_id":CGMainDisplayID(),"pid":ProcessInfo.processInfo.processIdentifier,"time":Date().timeIntervalSince1970,"windows":wins.map { ["id":$0.windowNumber,"title":$0.title,"x":$0.frame.minX,"y":$0.frame.minY,"width":$0.frame.width,"height":$0.frame.height] as [String:Any] }]
 if let data=try? JSONSerialization.data(withJSONObject:state,options:.sortedKeys) {try? data.write(to:root.appendingPathComponent("scene-applied.json"),options:.atomic)}
}
var seen=""
let timer=Timer.scheduledTimer(withTimeInterval:0.08,repeats:true) { _ in
 guard let data=try? Data(contentsOf:root.appendingPathComponent("scene.json")),let raw=String(data:data,encoding:.utf8),raw != seen else{return};seen=raw
 if let json=(try? JSONSerialization.jsonObject(with:data)) as? [String:Any],let name=json["case"] as? String {apply(name)}
}
apply("five");app.run()
