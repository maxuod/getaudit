import AppKit
import Foundation
let directory=CommandLine.arguments[1]
try FileManager.default.createDirectory(atPath:directory,withIntermediateDirectories:true)
for size in [16,32,128,256,512] {
 for scale in [1,2] {
  let pixels=size*scale
  let rep=NSBitmapImageRep(bitmapDataPlanes:nil,pixelsWide:pixels,pixelsHigh:pixels,bitsPerSample:8,samplesPerPixel:4,hasAlpha:true,isPlanar:false,colorSpaceName:.deviceRGB,bytesPerRow:0,bitsPerPixel:0)!
  NSGraphicsContext.saveGraphicsState();NSGraphicsContext.current=NSGraphicsContext(bitmapImageRep:rep)
  let unit=CGFloat(pixels)/1024
  let bg=NSBezierPath(roundedRect:NSRect(x:48*unit,y:48*unit,width:928*unit,height:928*unit),xRadius:210*unit,yRadius:210*unit)
  NSColor(srgbRed:1,green:0.976,blue:0.957,alpha:1).setFill();bg.fill()
  // Dot is the curious getaudit companion. A single face remains legible in the Dock.
  let paper=NSBezierPath(roundedRect:NSRect(x:230*unit,y:198*unit,width:570*unit,height:610*unit),xRadius:74*unit,yRadius:74*unit)
  NSColor.white.setFill();paper.fill()
  let body=NSBezierPath(roundedRect:NSRect(x:236*unit,y:274*unit,width:552*unit,height:548*unit),xRadius:184*unit,yRadius:184*unit)
  let tilt=AffineTransform(translationByX:512*unit,byY:548*unit)
  var curious=tilt
  curious.rotate(byDegrees:-8)
  curious.translate(x:-512*unit,y:-548*unit)
  body.transform(using:curious)
  NSColor(srgbRed:0.953,green:0.420,blue:0.141,alpha:1).setFill();body.fill()
  for x in [398,574] {
   let eye=NSBezierPath(ovalIn:NSRect(x:CGFloat(x)*unit,y:536*unit,width:62*unit,height:92*unit))
   eye.transform(using:curious)
   NSColor.white.setFill();eye.fill()
  }
  let note=NSBezierPath(roundedRect:NSRect(x:340*unit,y:220*unit,width:344*unit,height:30*unit),xRadius:15*unit,yRadius:15*unit)
  NSColor(srgbRed:0.941,green:0.875,blue:0.824,alpha:1).setFill();note.fill()
  NSGraphicsContext.restoreGraphicsState()
  let name="icon_\(size)x\(size)"+(scale==2 ? "@2x":"")+".png"
  try rep.representation(using:.png,properties:[:])!.write(to:URL(fileURLWithPath:directory).appendingPathComponent(name))
 }
}
