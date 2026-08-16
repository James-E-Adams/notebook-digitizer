#!/usr/bin/env swift
import Foundation
import Vision
import ImageIO

struct Line: Codable {
    let text: String
    let confidence: Float
    let x: Double
    let y: Double
    let width: Double
    let height: Double
}

struct Result: Codable {
    let lines: [Line]
}

guard let argument = CommandLine.arguments.dropFirst().first else {
    fputs("Pass an image path\n", stderr)
    exit(2)
}

let url = URL(fileURLWithPath: argument)
guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
      let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
    fputs("Could not load image\n", stderr)
    exit(2)
}

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = true
request.recognitionLanguages = ["en-AU", "en-US"]
let handler = VNImageRequestHandler(cgImage: image, orientation: .up, options: [:])
try handler.perform([request])

var lines: [Line] = (request.results ?? []).compactMap { observation in
    guard let candidate = observation.topCandidates(1).first else { return nil }
    let box = observation.boundingBox
    return Line(text: candidate.string, confidence: candidate.confidence,
                x: box.origin.x, y: box.origin.y,
                width: box.size.width, height: box.size.height)
}
lines.sort {
    if abs($0.y - $1.y) > 0.012 { return $0.y > $1.y }
    return $0.x < $1.x
}
let data = try JSONEncoder().encode(Result(lines: lines))
print(String(data: data, encoding: .utf8)!)
