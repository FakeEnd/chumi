// CoreAudioUtils.swift — small typed wrappers over the AudioObject property API.

import Foundation
import CoreAudio

struct CoreAudioError: Error, CustomStringConvertible {
    let status: OSStatus
    let what: String
    var description: String { "\(what) failed (\(fourCC(status)))" }
}

/// Render an OSStatus as a four-char code when printable, else as a number.
func fourCC(_ status: OSStatus) -> String {
    let u = UInt32(bitPattern: status)
    let bytes = [UInt8((u >> 24) & 0xff), UInt8((u >> 16) & 0xff), UInt8((u >> 8) & 0xff), UInt8(u & 0xff)]
    if bytes.allSatisfy({ $0 >= 0x20 && $0 < 0x7f }) {
        return "'" + String(decoding: bytes, as: UTF8.self) + "' (\(status))"
    }
    return String(status)
}

enum CA {
    static func address(_ selector: AudioObjectPropertySelector,
                        _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal,
                        _ element: AudioObjectPropertyElement = kAudioObjectPropertyElementMain) -> AudioObjectPropertyAddress {
        AudioObjectPropertyAddress(mSelector: selector, mScope: scope, mElement: element)
    }

    /// Read a fixed-size (POD) property.
    static func get<T>(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector,
                       scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal, initial: T) -> T? {
        var addr = address(selector, scope)
        var value = initial
        var size = UInt32(MemoryLayout<T>.size)
        let status = withUnsafeMutablePointer(to: &value) { ptr in
            AudioObjectGetPropertyData(object, &addr, 0, nil, &size, ptr)
        }
        return status == noErr ? value : nil
    }

    /// Read a CFString property.
    static func string(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector,
                       scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal) -> String? {
        var addr = address(selector, scope)
        var ref: Unmanaged<CFString>? = nil
        var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        let status = withUnsafeMutablePointer(to: &ref) { ptr in
            AudioObjectGetPropertyData(object, &addr, 0, nil, &size, ptr)
        }
        guard status == noErr, let r = ref else { return nil }
        return r.takeRetainedValue() as String
    }

    /// Read an array-of-AudioObjectID property.
    static func objectList(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector,
                           scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal) -> [AudioObjectID] {
        var addr = address(selector, scope)
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(object, &addr, 0, nil, &size) == noErr, size > 0 else { return [] }
        var ids = [AudioObjectID](repeating: kAudioObjectUnknown, count: Int(size) / MemoryLayout<AudioObjectID>.size)
        let status = ids.withUnsafeMutableBytes { raw in
            AudioObjectGetPropertyData(object, &addr, 0, nil, &size, raw.baseAddress!)
        }
        guard status == noErr else { return [] }
        return Array(ids.prefix(Int(size) / MemoryLayout<AudioObjectID>.size))
    }

    static func allDevices() -> [AudioObjectID] {
        objectList(AudioObjectID(kAudioObjectSystemObject), kAudioHardwarePropertyDevices)
    }

    static func defaultInputDevice() -> AudioObjectID? {
        let id = get(AudioObjectID(kAudioObjectSystemObject), kAudioHardwarePropertyDefaultInputDevice, initial: AudioObjectID(kAudioObjectUnknown))
        return (id == nil || id == kAudioObjectUnknown) ? nil : id
    }

    static func defaultOutputDevice() -> AudioObjectID? {
        let id = get(AudioObjectID(kAudioObjectSystemObject), kAudioHardwarePropertyDefaultOutputDevice, initial: AudioObjectID(kAudioObjectUnknown))
        return (id == nil || id == kAudioObjectUnknown) ? nil : id
    }

    static func uid(_ device: AudioObjectID) -> String? { string(device, kAudioDevicePropertyDeviceUID) }
    static func name(_ device: AudioObjectID) -> String? { string(device, kAudioObjectPropertyName) }

    /// Total channel count of a device in the given scope (from kAudioDevicePropertyStreamConfiguration).
    static func channelCount(_ device: AudioObjectID, scope: AudioObjectPropertyScope) -> Int {
        var addr = address(kAudioDevicePropertyStreamConfiguration, scope)
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(device, &addr, 0, nil, &size) == noErr, size > 0 else { return 0 }
        let raw = UnsafeMutableRawPointer.allocate(byteCount: Int(size), alignment: 16)
        defer { raw.deallocate() }
        guard AudioObjectGetPropertyData(device, &addr, 0, nil, &size, raw) == noErr else { return 0 }
        let abl = UnsafeMutableAudioBufferListPointer(raw.assumingMemoryBound(to: AudioBufferList.self))
        return abl.reduce(0) { $0 + Int($1.mNumberChannels) }
    }

    /// Number of streams of a device in the given scope.
    static func streamCount(_ device: AudioObjectID, scope: AudioObjectPropertyScope) -> Int {
        objectList(device, kAudioDevicePropertyStreams, scope: scope).count
    }

    static func nominalSampleRate(_ device: AudioObjectID) -> Double? {
        get(device, kAudioDevicePropertyNominalSampleRate, initial: Float64(0))
    }

    static func device(forUID uid: String) -> AudioObjectID? {
        allDevices().first { CA.uid($0) == uid }
    }

    /// Translate a PID to its Core Audio process object (macOS 14.2+). nil when the process has no audio object.
    static func processObject(pid: pid_t) -> AudioObjectID? {
        var addr = address(kAudioHardwarePropertyTranslatePIDToProcessObject)
        var qualifier = pid
        var result = AudioObjectID(kAudioObjectUnknown)
        var size = UInt32(MemoryLayout<AudioObjectID>.size)
        let status = AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr,
                                                UInt32(MemoryLayout<pid_t>.size), &qualifier, &size, &result)
        return (status == noErr && result != kAudioObjectUnknown) ? result : nil
    }

    static func tapFormat(_ tap: AudioObjectID) -> AudioStreamBasicDescription? {
        get(tap, kAudioTapPropertyFormat, initial: AudioStreamBasicDescription())
    }

    static func describe(_ f: AudioStreamBasicDescription) -> String {
        let isFloat = (f.mFormatFlags & kAudioFormatFlagIsFloat) != 0
        let nonInterleaved = (f.mFormatFlags & kAudioFormatFlagIsNonInterleaved) != 0
        return "\(Int(f.mSampleRate)) Hz, \(f.mChannelsPerFrame) ch, \(f.mBitsPerChannel)-bit \(isFloat ? "float" : "int"), \(nonInterleaved ? "non-interleaved" : "interleaved")"
    }
}
