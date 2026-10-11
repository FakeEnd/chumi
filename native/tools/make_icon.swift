// make_icon.swift — renders the Chumi app icon (same design as assets/logo.svg) to a 1024×1024 PNG.
// Usage: make_icon <out.png>
import AppKit

let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "icon.png"
let size = 1024
let cs = CGColorSpaceCreateDeviceRGB()
guard let ctx = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0, space: cs,
                          bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { exit(1) }
// Use SVG coordinates (y down) so the geometry matches assets/logo.svg exactly.
ctx.translateBy(x: 0, y: CGFloat(size))
ctx.scaleBy(x: 1, y: -1)

func rgb(_ hex: UInt32) -> CGColor {
    CGColor(red: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255, blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
}
func gradient(_ a: UInt32, _ b: UInt32) -> CGGradient {
    CGGradient(colorsSpace: cs, colors: [rgb(a), rgb(b)] as CFArray, locations: [0, 1])!
}
func fillGradient(_ path: CGPath, _ g: CGGradient, from: CGPoint, to: CGPoint) {
    ctx.saveGState(); ctx.addPath(path); ctx.clip()
    ctx.drawLinearGradient(g, start: from, end: to, options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
    ctx.restoreGState()
}

// App tile
let tile = CGPath(roundedRect: CGRect(x: 100, y: 100, width: 824, height: 824), cornerWidth: 190, cornerHeight: 190, transform: nil)
fillGradient(tile, gradient(0x4338CA, 0x0E9FB8), from: CGPoint(x: 100, y: 100), to: CGPoint(x: 924, y: 924))

// Speech bubble (rounded body + tail)
ctx.setFillColor(rgb(0xFFFFFF))
ctx.addPath(CGPath(roundedRect: CGRect(x: 232, y: 300, width: 560, height: 340), cornerWidth: 110, cornerHeight: 110, transform: nil))
ctx.fillPath()
let tail = CGMutablePath()
tail.move(to: CGPoint(x: 448, y: 639)); tail.addLine(to: CGPoint(x: 330, y: 742)); tail.addLine(to: CGPoint(x: 356, y: 639)); tail.closeSubpath()
ctx.addPath(tail); ctx.fillPath()

// Sound wave, one continuous gradient across the bars
let bars = CGMutablePath()
let heights: [CGFloat] = [70, 140, 210, 250, 210, 140, 70]
for (i, h) in heights.enumerated() {
    let x = 296 + CGFloat(i) * 68
    bars.addPath(CGPath(roundedRect: CGRect(x: x, y: 470 - h / 2, width: 40, height: h), cornerWidth: 20, cornerHeight: 20, transform: nil))
}
fillGradient(bars, gradient(0x4F46E5, 0x0891B2), from: CGPoint(x: 296, y: 0), to: CGPoint(x: 744, y: 0))

// Spark
let spark = CGMutablePath()
let c = CGPoint(x: 790, y: 290), r: CGFloat = 94
spark.move(to: CGPoint(x: c.x, y: c.y - r))
spark.addQuadCurve(to: CGPoint(x: c.x + r, y: c.y), control: c)
spark.addQuadCurve(to: CGPoint(x: c.x, y: c.y + r), control: c)
spark.addQuadCurve(to: CGPoint(x: c.x - r, y: c.y), control: c)
spark.addQuadCurve(to: CGPoint(x: c.x, y: c.y - r), control: c)
spark.closeSubpath()
fillGradient(spark, gradient(0xFDE68A, 0xF59E0B), from: CGPoint(x: c.x - r, y: c.y - r), to: CGPoint(x: c.x + r, y: c.y + r))
ctx.setStrokeColor(rgb(0xFFFFFF)); ctx.setLineWidth(14); ctx.setLineJoin(.round)
ctx.addPath(spark); ctx.strokePath()
ctx.setFillColor(rgb(0xFDE68A))
ctx.fillEllipse(in: CGRect(x: 866 - 17, y: 212 - 17, width: 34, height: 34))

guard let img = ctx.makeImage() else { exit(1) }
let rep = NSBitmapImageRep(cgImage: img)
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: out))
