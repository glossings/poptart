// poptart-midi: poptart's CoreMIDI helper, run by ../server/midi-worker.js.
//
// It only talks to MIDI devices: it lists them, connects sources, writes every incoming message to
// stdout (from CoreMIDI's own thread, so nothing in Node can hold input back), and sends what it is
// told, stamping each packet with the host time it is meant for. A stamped packet is delivered on
// CoreMIDI's clock, so a clock tick's jitter is the driver's, not the sender's.
//
// Protocol: one line per message, fields separated by tabs. Times are host time in nanoseconds
// (mach_absolute_time scaled by the timebase). Bytes are hex.
//   stdin:
//     list                          answered by `devices`
//     connect <uid> | connectAll
//     now <id>                      answered by `now <id> <ns>` (clock sync)
//     send <id> <uid> <ns> <hex>    ns 0 = at once; id > 0 asks for `sent <id> <stamped ns>`
//     virtual <name>                makes a virtual source and destination of that name (tests)
//     emit <hex>                    sends from the virtual source (tests)
//     quit
//   stdout:
//     hello <version>
//     devices <json>                {"sources":[{uid,device,name}],"destinations":[...]}
//     in <uid> <ns> <hex>           one message from a connected source
//     vin <ns-stamp> <ns-now> <hex> one message reaching the virtual destination (tests)
//     now <id> <ns> | sent <id> <ns> | err <text>

import CoreMIDI
import Foundation

let version = "1"
var timebase = mach_timebase_info_data_t()
mach_timebase_info(&timebase)

func ns(_ host: UInt64) -> UInt64 { host * UInt64(timebase.numer) / UInt64(timebase.denom) }
func host(_ n: UInt64) -> UInt64 { n * UInt64(timebase.denom) / UInt64(timebase.numer) }

let outLock = NSLock()
func emitLine(_ s: String) {
    outLock.lock()
    FileHandle.standardOutput.write((s + "\n").data(using: .utf8)!)
    outLock.unlock()
}

func hex(_ bytes: UnsafeBufferPointer<UInt8>) -> String {
    bytes.map { String(format: "%02x", $0) }.joined()
}

func unhex(_ s: Substring) -> [UInt8] {
    var out: [UInt8] = []
    var i = s.startIndex
    while i < s.endIndex, let j = s.index(i, offsetBy: 2, limitedBy: s.endIndex) {
        if let b = UInt8(s[i..<j], radix: 16) { out.append(b) }
        i = j
    }
    return out
}

func stringProp(_ obj: MIDIObjectRef, _ prop: CFString) -> String? {
    var cf: Unmanaged<CFString>?
    guard MIDIObjectGetStringProperty(obj, prop, &cf) == noErr, let v = cf?.takeRetainedValue() else { return nil }
    return v as String
}

func uidOf(_ obj: MIDIObjectRef) -> Int32 {
    var v: Int32 = 0
    MIDIObjectGetIntegerProperty(obj, kMIDIPropertyUniqueID, &v)
    return v
}

// The class library's naming: the endpoint's device name and its own name.
func describe(_ ep: MIDIEndpointRef) -> [String: Any] {
    let name = stringProp(ep, kMIDIPropertyName) ?? ""
    var ent: MIDIEntityRef = 0
    var dev: MIDIDeviceRef = 0
    var device = name
    if MIDIEndpointGetEntity(ep, &ent) == noErr, ent != 0, MIDIEntityGetDevice(ent, &dev) == noErr, dev != 0 {
        device = stringProp(dev, kMIDIPropertyName) ?? name
    }
    return ["uid": Int(uidOf(ep)), "device": device, "name": name]
}

func listDevices() {
    var sources: [[String: Any]] = []
    for i in 0..<MIDIGetNumberOfSources() { sources.append(describe(MIDIGetSource(i))) }
    var dests: [[String: Any]] = []
    for i in 0..<MIDIGetNumberOfDestinations() { dests.append(describe(MIDIGetDestination(i))) }
    let json = try! JSONSerialization.data(withJSONObject: ["sources": sources, "destinations": dests])
    emitLine("devices\t" + String(data: json, encoding: .utf8)!)
}

func endpoint(uid: Int32, sources: Bool) -> MIDIEndpointRef? {
    let n = sources ? MIDIGetNumberOfSources() : MIDIGetNumberOfDestinations()
    for i in 0..<n {
        let ep = sources ? MIDIGetSource(i) : MIDIGetDestination(i)
        if uidOf(ep) == uid { return ep }
    }
    return nil
}

// Splits a packet into messages (running status included) and calls `each` per message.
func messages(_ data: UnsafeBufferPointer<UInt8>, _ each: (UnsafeBufferPointer<UInt8>) -> Void) {
    var i = 0
    var status: UInt8 = 0
    var scratch = [UInt8](repeating: 0, count: 3)
    while i < data.count {
        var b = data[i]
        if b >= 0xF8 { // realtime: one byte, anywhere
            scratch[0] = b
            scratch.withUnsafeBufferPointer { each(UnsafeBufferPointer(rebasing: $0[0..<1])) }
            i += 1
            continue
        }
        if b == 0xF0 { // sysex: through F7
            var j = i + 1
            while j < data.count && data[j] != 0xF7 { j += 1 }
            let end = min(j + 1, data.count)
            each(UnsafeBufferPointer(rebasing: data[i..<end]))
            i = end
            continue
        }
        if b & 0x80 != 0 { status = b; i += 1 } else if status == 0 { i += 1; continue }
        b = status
        let hi = b & 0xF0
        let len: Int
        switch hi {
        case 0xC0, 0xD0: len = 1
        case 0xF0: len = (b == 0xF2) ? 2 : (b == 0xF1 || b == 0xF3) ? 1 : 0
        default: len = 2
        }
        scratch[0] = b
        var k = 0
        while k < len && i < data.count && data[i] & 0x80 == 0 { scratch[1 + k] = data[i]; k += 1; i += 1 }
        if k == len { scratch.withUnsafeBufferPointer { each(UnsafeBufferPointer(rebasing: $0[0..<(1 + len)])) } }
    }
}

func walk(_ list: UnsafePointer<MIDIPacketList>, _ each: (UInt64, UnsafeBufferPointer<UInt8>) -> Void) {
    for packet in list.unsafeSequence() {
        let len = Int(packet.pointee.length)
        withUnsafeBytes(of: packet.pointee.data) { raw in
            let bytes = raw.bindMemory(to: UInt8.self)
            each(packet.pointee.timeStamp, UnsafeBufferPointer(rebasing: bytes[0..<min(len, bytes.count)]))
        }
    }
}

var client: MIDIClientRef = 0
var inPort: MIDIPortRef = 0
var outPort: MIDIPortRef = 0
var virtualSource: MIDIEndpointRef = 0
var virtualDest: MIDIEndpointRef = 0
var connected = Set<Int32>()

let status = MIDIClientCreateWithBlock("poptart" as CFString, &client) { note in
    // A device plugged in or out: the next `list` reads it. Nothing to say unprompted.
    _ = note
}
if status != noErr {
    emitLine("err\tMIDIClientCreate failed (\(status))")
    exit(1)
}
MIDIInputPortCreateWithBlock(client, "poptart in" as CFString, &inPort) { list, srcRef in
    let uid = Int32(truncatingIfNeeded: Int(bitPattern: srcRef))
    walk(list) { stamp, data in
        let t = ns(stamp == 0 ? mach_absolute_time() : stamp)
        messages(data) { m in emitLine("in\t\(uid)\t\(t)\t\(hex(m))") }
    }
}
MIDIOutputPortCreate(client, "poptart out" as CFString, &outPort)

func connect(_ ep: MIDIEndpointRef) {
    let uid = uidOf(ep)
    if connected.contains(uid) { return }
    connected.insert(uid)
    // The uid rides along as the connection's refCon, so each message says where it came from.
    MIDIPortConnectSource(inPort, ep, UnsafeMutableRawPointer(bitPattern: Int(uid)))
}

func send(uid: Int32, at: UInt64, bytes: [UInt8]) -> UInt64? {
    let ep: MIDIEndpointRef? = (virtualDest != 0 && uidOf(virtualDest) == uid) ? virtualDest : endpoint(uid: uid, sources: false)
    guard let dest = ep else { return nil }
    let stamp: UInt64 = at == 0 ? 0 : host(at)
    var buf = [UInt8](repeating: 0, count: 1024 + bytes.count)
    buf.withUnsafeMutableBytes { raw in
        let list = raw.baseAddress!.assumingMemoryBound(to: MIDIPacketList.self)
        var pkt = MIDIPacketListInit(list)
        pkt = MIDIPacketListAdd(list, raw.count, pkt, stamp, bytes.count, bytes)
        MIDISend(outPort, dest, list)
    }
    return stamp == 0 ? ns(mach_absolute_time()) : ns(stamp)
}

func makeVirtual(_ name: String) {
    if virtualSource == 0 { MIDISourceCreate(client, name as CFString, &virtualSource) }
    if virtualDest == 0 {
        MIDIDestinationCreateWithBlock(client, name as CFString, &virtualDest) { list, _ in
            let arrived = ns(mach_absolute_time())
            walk(list) { stamp, data in
                let s = stamp == 0 ? arrived : ns(stamp)
                messages(data) { m in emitLine("vin\t\(s)\t\(arrived)\t\(hex(m))") }
            }
        }
    }
}

func emitVirtual(_ bytes: [UInt8]) {
    guard virtualSource != 0 else { return }
    var buf = [UInt8](repeating: 0, count: 1024 + bytes.count)
    buf.withUnsafeMutableBytes { raw in
        let list = raw.baseAddress!.assumingMemoryBound(to: MIDIPacketList.self)
        var pkt = MIDIPacketListInit(list)
        pkt = MIDIPacketListAdd(list, raw.count, pkt, 0, bytes.count, bytes)
        MIDIReceived(virtualSource, list)
    }
}

emitLine("hello\t\(version)")

// Commands, one per line, on a thread of their own; CoreMIDI's callbacks need no run loop of ours.
let reader = Thread {
    while let line = readLine(strippingNewline: true) {
        let f = line.split(separator: "\t", omittingEmptySubsequences: false)
        guard let cmd = f.first else { continue }
        switch cmd {
        case "list":
            listDevices()
        case "connect":
            if f.count > 1, let uid = Int32(f[1]), let ep = endpoint(uid: uid, sources: true) { connect(ep) }
        case "connectAll":
            for i in 0..<MIDIGetNumberOfSources() { connect(MIDIGetSource(i)) }
        case "now":
            emitLine("now\t\(f.count > 1 ? String(f[1]) : "0")\t\(ns(mach_absolute_time()))")
        case "send":
            if f.count > 4, let id = Int(f[1]), let uid = Int32(f[2]), let at = UInt64(f[3]) {
                let stamped = send(uid: uid, at: at, bytes: unhex(f[4]))
                if id > 0 { emitLine("sent\t\(id)\t\(stamped ?? 0)") }
            }
        case "virtual":
            if f.count > 1 { makeVirtual(String(f[1])) }
            listDevices()
        case "emit":
            if f.count > 1 { emitVirtual(unhex(f[1])) }
        case "quit":
            exit(0)
        default:
            emitLine("err\tunknown command \(cmd)")
        }
    }
    // stdin closed: whoever ran this has gone.
    exit(0)
}
reader.start()
RunLoop.main.run()
