import CoreGraphics
import Foundation
import ApplicationServices

// 固定路径、稳定签名的 OS 级按键注入器：走 CGEvent HID tap，经过系统输入法管线。
let keyCodes: [Character: CGKeyCode] = [
  "a":0x00,"s":0x01,"d":0x02,"f":0x03,"h":0x04,"g":0x05,"z":0x06,"x":0x07,"c":0x08,"v":0x09,
  "b":0x0B,"q":0x0C,"w":0x0D,"e":0x0E,"r":0x0F,"y":0x10,"t":0x11,"1":0x12,"2":0x13,"3":0x14,
  "4":0x15,"6":0x16,"5":0x17,"9":0x19,"7":0x1A,"8":0x1C,"0":0x1D,"o":0x1F,"u":0x20,"i":0x22,
  "p":0x23,"l":0x25,"j":0x26,"k":0x28,"n":0x2D,"m":0x2E,".":0x2F," ":0x31,"\n":0x24
]

func post(_ code: CGKeyCode, flags: CGEventFlags = [], down: Bool) {
  let src = CGEventSource(stateID: .hidSystemState)
  guard let event = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: down) else { return }
  event.flags = flags
  event.post(tap: .cghidEventTap)
  usleep(down ? 40_000 : 60_000)
}

func type(_ text: String) {
  for character in text {
    guard let code = keyCodes[character] else { continue }
    post(code, down: true)
    post(code, down: false)
  }
}

let arguments = CommandLine.arguments
let command = arguments.count > 1 ? arguments[1] : "check"
switch command {
case "check":
  print(AXIsProcessTrusted() ? "trusted" : "untrusted")
case "request":
  let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
  print(AXIsProcessTrustedWithOptions(options) ? "trusted" : "requested")
case "type":
  type(arguments.count > 2 ? arguments[2] : "")
  print("typed")
case "key":
  // xjkeys key <name> [cmd]
  let name = arguments.count > 2 ? arguments[2] : "space"
  let withCommand = arguments.contains("cmd")
  let codes: [String: CGKeyCode] = ["space":0x31,"return":0x24,"left":0x7B,"right":0x7C,"esc":0x35]
  guard let code = codes[name] else { print("unknown-key"); exit(2) }
  let flags: CGEventFlags = withCommand ? .maskCommand : []
  post(code, flags: flags, down: true)
  post(code, flags: flags, down: false)
  print("key \(name)\(withCommand ? "+cmd" : "")")
case "paste":
  // 真实 Cmd+V：读取系统剪贴板
  post(0x09, flags: .maskCommand, down: true)
  post(0x09, flags: .maskCommand, down: false)
  print("pasted")
default:
  print("usage: xjkeys check|request|type <text>|key <name> [cmd]|paste")
  exit(2)
}
