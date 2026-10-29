#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <audioclient.h>
#include <mmdeviceapi.h>
#include <initguid.h>
#include <functiondiscoverykeys_devpkey.h>
#include <propvarutil.h>
#include <fcntl.h>
#include <io.h>
#include <algorithm>
#include <atomic>
#include <cmath>
#include <condition_variable>
#include <cstdio>
#include <cstring>
#include <deque>
#include <future>
#include <iostream>
#include <mutex>
#include <string>
#include <thread>
#include <vector>
#include "json.hpp"

using json = nlohmann::json;

// Every object stays on the thread which activated it.
template <class T> struct ComPtr {
    T* value = nullptr;
    ~ComPtr() { if (value) value->Release(); }
    T* operator->() const { return value; }
    T** out() { return &value; }
};
struct ComApartment {
    ComApartment() { CoInitializeEx(nullptr, COINIT_MULTITHREADED); }
    ~ComApartment() { CoUninitialize(); }
};
struct AudioError { HRESULT code; std::string operation; };
static void check(HRESULT hr, const char* operation) { if (FAILED(hr)) throw AudioError{hr, operation}; }
static std::string utf8(const std::wstring& text) {
    if (text.empty()) return {};
    int n = WideCharToMultiByte(CP_UTF8, 0, text.data(), (int)text.size(), nullptr, 0, nullptr, nullptr);
    std::string result(n, '\0');
    WideCharToMultiByte(CP_UTF8, 0, text.data(), (int)text.size(), result.data(), n, nullptr, nullptr);
    return result;
}
static std::string errorMessage(const AudioError& error) {
    if (error.code == E_ACCESSDENIED) return "Allow desktop apps to access the microphone in Windows Settings > Privacy & security > Microphone.";
    if (error.code == AUDCLNT_E_DEVICE_INVALIDATED) return "The audio device was disconnected. Reconnecting...";
    char code[16]; std::snprintf(code, sizeof(code), "0x%08lx", (unsigned long)error.code);
    return error.operation + " (" + code + ")";
}
static double clockSeconds() {
    LARGE_INTEGER count, frequency;
    QueryPerformanceCounter(&count); QueryPerformanceFrequency(&frequency);
    return double(count.QuadPart) / double(frequency.QuadPart);
}
static std::mutex eventMutex;
static void event(const json& value) {
    std::lock_guard lock(eventMutex);
    std::cerr << value.dump() << '\n';
}
static HANDLE stopEvent;
static BOOL WINAPI onConsoleSignal(DWORD) { SetEvent(stopEvent); return TRUE; }

// Bounded queue: audio threads never block on a slow consumer. Binary stdout has exactly one writer.
class Output {
    std::mutex mutex;
    std::condition_variable changed;
    std::deque<std::vector<char>> queue;
    size_t queuedBytes = 0;
    bool ending = false;
    double warnedAt = 0;
    std::thread writer;
public:
    Output() : writer([this] {
        for (;;) {
            std::vector<char> frame;
            {
                std::unique_lock lock(mutex);
                changed.wait(lock, [this] { return ending || !queue.empty(); });
                if (queue.empty()) return;
                frame = std::move(queue.front()); queue.pop_front(); queuedBytes -= frame.size();
            }
            if (std::fwrite(frame.data(), 1, frame.size(), stdout) != frame.size()) { SetEvent(stopEvent); return; }
        }
    }) { }
    void frame(uint8_t source, double timestamp, const int16_t* samples, uint32_t count) {
        std::vector<char> bytes(20 + count * 2, 0);
        std::memcpy(bytes.data(), "CHA1", 4); bytes[4] = (char)source;
        std::memcpy(bytes.data() + 8, &timestamp, 8); std::memcpy(bytes.data() + 16, &count, 4);
        std::memcpy(bytes.data() + 20, samples, count * 2);
        std::lock_guard lock(mutex);
        if (queuedBytes + bytes.size() > 8 * 1024 * 1024) {
            if (clockSeconds() - warnedAt > 5) {
                warnedAt = clockSeconds();
                event({{"type", "warning"}, {"code", "stdout_backpressure"}, {"message", "Audio processing is falling behind; some audio was skipped."}});
            }
            return;
        }
        queuedBytes += bytes.size(); queue.push_back(std::move(bytes)); changed.notify_one();
    }
    ~Output() { { std::lock_guard lock(mutex); ending = true; } changed.notify_one(); writer.join(); }
};

static std::wstring deviceId(IMMDevice* device) {
    LPWSTR id = nullptr; check(device->GetId(&id), "Read audio device ID");
    std::wstring result(id); CoTaskMemFree(id); return result;
}
static std::string deviceName(IMMDevice* device) {
    ComPtr<IPropertyStore> properties;
    check(device->OpenPropertyStore(STGM_READ, properties.out()), "Read audio device name");
    PROPVARIANT name; PropVariantInit(&name);
    check(properties->GetValue(PKEY_Device_FriendlyName, &name), "Read audio device name");
    std::string result = name.vt == VT_LPWSTR ? utf8(name.pwszVal) : "Audio device";
    PropVariantClear(&name); return result;
}
static void selectDevice(IMMDeviceEnumerator* devices, uint8_t source, const std::wstring& micId, IMMDevice** result) {
    check(source == 1 && !micId.empty() ? devices->GetDevice(micId.c_str(), result)
        : devices->GetDefaultAudioEndpoint(source == 2 ? eRender : eCapture, source == 2 ? eMultimedia : eConsole, result), "Find audio device");
}

class Source {
    uint8_t id;
    std::wstring micId;
    int chunkSamples;
    Output& output;
    double baseTime;
    std::vector<int16_t> buffer;
    double nextTime = -1, lastLevel = 0, silentSince = 0;
    bool silenceReported = false;
    std::promise<json> started;
    std::thread worker;
    const char* name() const { return id == 2 ? "system" : "mic"; }

    void flush() {
        if (buffer.empty()) return;
        output.frame(id, nextTime, buffer.data(), (uint32_t)buffer.size());
        double sum = 0, peak = 0;
        for (int16_t sample : buffer) { double x = sample / 32768.0; sum += x * x; peak = std::max(peak, std::abs(x)); }
        double now = clockSeconds() - baseTime;
        if (now - lastLevel >= 0.1) {
            event({{"type", "level"}, {"source", name()}, {"rms", 10 * std::log10(sum / buffer.size() + 1e-12)}, {"peak", 20 * std::log10(peak + 1e-6)}});
            lastLevel = now;
        }
        if (peak > 0) {
            silentSince = now;
            if (silenceReported) event({{"type", "info"}, {"code", std::string(name()) + "_silent_cleared"}});
            silenceReported = false;
        } else if (!silenceReported && now - silentSince > (id == 2 ? 15 : 10)) {
            silenceReported = true;
            event({{"type", "warning"}, {"code", std::string(name()) + "_silent"}, {"message", id == 2
                ? "No computer sound yet. Play audio in your meeting app on the current Windows output device."
                : "The microphone is sending silence. Check its mute switch and Windows microphone settings."}});
        }
        nextTime += buffer.size() / 16000.0; buffer.clear();
    }
    void append(const int16_t* data, size_t count, double timestamp) {
        if (nextTime < 0 || std::abs(timestamp - (nextTime + buffer.size() / 16000.0)) > 0.2) { flush(); nextTime = std::max(0.0, timestamp); }
        while (count) {
            size_t take = std::min(count, (size_t)chunkSamples - buffer.size());
            if (data) { buffer.insert(buffer.end(), data, data + take); data += take; }
            else buffer.insert(buffer.end(), take, 0);
            count -= take;
            if (buffer.size() == (size_t)chunkSamples) flush();
        }
    }
    void run() {
        ComApartment apartment;
        ComPtr<IMMDeviceEnumerator> devices;
        bool announced = false;
        unsigned reconnectAttempt = 0;
        const DWORD retryDelays[] = {1000, 2000, 5000, 10000};
        try { check(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, __uuidof(IMMDeviceEnumerator), (void**)devices.out()), "Open Windows audio"); }
        catch (const AudioError& error) { started.set_value({{"error", errorMessage(error)}}); return; }
        while (WaitForSingleObject(stopEvent, 0) != WAIT_OBJECT_0) {
            try {
                ComPtr<IMMDevice> device; selectDevice(devices.value, id, micId, device.out());
                auto uid = deviceId(device.value); auto friendlyName = deviceName(device.value);
                ComPtr<IAudioClient> client;
                check(device->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, (void**)client.out()), "Activate audio capture");
                WAVEFORMATEX format = { WAVE_FORMAT_PCM, 1, 16000, 32000, 2, 16, 0 };
                DWORD flags = AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY;
                if (id == 2) flags |= AUDCLNT_STREAMFLAGS_LOOPBACK;
                check(client->Initialize(AUDCLNT_SHAREMODE_SHARED, flags, 1000000, 0, &format, nullptr), "Start shared-mode audio");
                ComPtr<IAudioCaptureClient> capture;
                check(client->GetService(__uuidof(IAudioCaptureClient), (void**)capture.out()), "Open audio stream");
                check(client->Start(), "Start audio device");
                reconnectAttempt = 0;
                if (!announced) { started.set_value({{"name", friendlyName}, {"uid", utf8(uid)}}); announced = true; }
                else event({{"type", "device_changed"}, {"kind", id == 2 ? "output" : "input"}, {"name", friendlyName}, {"uid", utf8(uid)}});
                double lastPacket = clockSeconds(), lastDeviceCheck = lastPacket;
                while (WaitForSingleObject(stopEvent, 5) != WAIT_OBJECT_0) {
                    UINT32 count = 0; check(capture->GetNextPacketSize(&count), "Read audio packet");
                    while (count) {
                        BYTE* samples; DWORD packetFlags; UINT64 devicePosition, qpc;
                        check(capture->GetBuffer(&samples, &count, &packetFlags, &devicePosition, &qpc), "Read audio samples");
                        double timestamp = (packetFlags & AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR) ? clockSeconds() - baseTime - count / 16000.0 : qpc / 10000000.0 - baseTime;
                        append(packetFlags & AUDCLNT_BUFFERFLAGS_SILENT ? nullptr : (int16_t*)samples, count, timestamp);
                        check(capture->ReleaseBuffer(count), "Release audio packet");
                        lastPacket = clockSeconds();
                        check(capture->GetNextPacketSize(&count), "Read next audio packet");
                    }
                    double now = clockSeconds();
                    // Loopback emits no packets during digital silence. Keep the shared timeline and VAD moving.
                    if (now - lastPacket > 0.2) {
                        if (nextTime < 0) nextTime = now - baseTime - 0.1;
                        while (nextTime + buffer.size() / 16000.0 + chunkSamples / 16000.0 <= now - baseTime - 0.1)
                            append(nullptr, chunkSamples, nextTime + buffer.size() / 16000.0);
                    }
                    if (now - lastDeviceCheck > 1 && (id == 2 || micId.empty())) {
                        lastDeviceCheck = now;
                        ComPtr<IMMDevice> current; selectDevice(devices.value, id, micId, current.out());
                        if (deviceId(current.value) != uid) break;
                    }
                }
                client->Stop(); flush(); nextTime = -1;
            } catch (const AudioError& error) {
                if (!announced) { started.set_value({{"error", errorMessage(error)}}); return; }
                if (reconnectAttempt == 0) event({{"type", "warning"}, {"code", "device_disconnected"}, {"message", errorMessage(error)}});
                flush(); nextTime = -1;
                const DWORD delay = retryDelays[reconnectAttempt];
                reconnectAttempt = std::min(reconnectAttempt + 1, 3u);
                if (WaitForSingleObject(stopEvent, delay) == WAIT_OBJECT_0) return;
            }
        }
    }
public:
    Source(uint8_t id, const std::wstring& micId, int chunkMs, Output& output, double baseTime)
        : id(id), micId(micId), chunkSamples(chunkMs * 16), output(output), baseTime(baseTime), worker([this] { run(); }) { }
    std::future<json> ready() { return started.get_future(); }
    ~Source() { worker.join(); }
};

static json permissions(IMMDeviceEnumerator* devices) {
    std::string mic = "granted";
    try {
        ComPtr<IMMDevice> device; selectDevice(devices, 1, {}, device.out());
        ComPtr<IAudioClient> client;
        check(device->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, (void**)client.out()), "Activate microphone");
        WAVEFORMATEX format = { WAVE_FORMAT_PCM, 1, 16000, 32000, 2, 16, 0 };
        check(client->Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY, 1000000, 0, &format, nullptr), "Check microphone access");
    } catch (const AudioError& error) { mic = error.code == E_ACCESSDENIED ? "denied" : "unavailable"; }
    return {{"microphone", mic}, {"systemAudio", "granted"}, {"systemAudioMethod", "wasapi_loopback"}};
}

int wmain(int argc, wchar_t** argv) {
    ComApartment apartment;
    stopEvent = CreateEvent(nullptr, TRUE, FALSE, nullptr);
    SetConsoleCtrlHandler(onConsoleSignal, TRUE);
    std::string source = "mic"; std::wstring micId; int chunkMs = 50; bool ignoreStdin = false;
    try {
        ComPtr<IMMDeviceEnumerator> devices;
        check(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, __uuidof(IMMDeviceEnumerator), (void**)devices.out()), "Open Windows audio");
        for (int i = 1; i < argc; ++i) {
            std::wstring arg(argv[i]);
            if (arg == L"--version") { std::cout << "chumi-audio 0.1.0 (Windows WASAPI)\n"; return 0; }
            if (arg == L"--help") { std::cout << "chumi-audio --source mic|system|both [--mic-device ID] [--chunk-ms 50]\n--list-devices | --check-permissions | --request-mic\n"; return 0; }
            if (arg == L"--check-permissions" || arg == L"--request-mic") { std::cout << permissions(devices.value).dump() << '\n'; return 0; }
            if (arg == L"--list-devices") {
                ComPtr<IMMDevice> defaultDevice; std::wstring defaultId;
                if (SUCCEEDED(devices->GetDefaultAudioEndpoint(eCapture, eConsole, defaultDevice.out()))) defaultId = deviceId(defaultDevice.value);
                ComPtr<IMMDeviceCollection> list;
                check(devices->EnumAudioEndpoints(eCapture, DEVICE_STATE_ACTIVE, list.out()), "List microphones");
                UINT count; check(list->GetCount(&count), "Count microphones");
                json result = json::array();
                for (UINT n = 0; n < count; ++n) {
                    ComPtr<IMMDevice> device; check(list->Item(n, device.out()), "Read microphone");
                    auto uid = deviceId(device.value);
                    result.push_back({{"uid", utf8(uid)}, {"name", deviceName(device.value)}, {"isDefault", uid == defaultId}, {"inputChannels", 1}});
                }
                std::cout << result.dump() << '\n'; return 0;
            }
            if (arg == L"--source" && i + 1 < argc) source = utf8(argv[++i]);
            else if (arg == L"--mic-device" && i + 1 < argc) micId = argv[++i];
            else if (arg == L"--chunk-ms" && i + 1 < argc) chunkMs = std::stoi(argv[++i]);
            else if (arg == L"--aec" && i + 1 < argc) ++i;
            else if (arg == L"--ignore-stdin") ignoreStdin = true;
            else if (arg != L"--self-responsible" && arg != L"--debug") throw std::runtime_error("Unknown or incomplete argument: " + utf8(arg));
        }
        if ((source != "mic" && source != "system" && source != "both") || chunkMs < 10 || chunkMs > 1000) throw std::runtime_error("Choose mic, system or both; chunk size must be 10-1000 ms.");
        _setmode(_fileno(stdout), _O_BINARY); std::setvbuf(stdout, nullptr, _IONBF, 0);
        if (!ignoreStdin) std::thread([] { char buffer[16]; DWORD read; while (ReadFile(GetStdHandle(STD_INPUT_HANDLE), buffer, sizeof(buffer), &read, nullptr) && read) {} SetEvent(stopEvent); }).detach();
        int result = 0;
        {
            Output output; std::vector<std::unique_ptr<Source>> inputs; json sources = json::array(); json mic = nullptr, system = nullptr;
            double base = clockSeconds();
            for (uint8_t id : {uint8_t(1), uint8_t(2)}) {
                if ((id == 1 && source == "system") || (id == 2 && source == "mic")) continue;
                auto input = std::make_unique<Source>(id, micId, chunkMs, output, base);
                auto state = input->ready().get();
                if (state.contains("error")) event({{"type", "error"}, {"code", id == 2 ? "system_start_failed" : "mic_start_failed"}, {"message", state["error"]}});
                else { sources.push_back(id == 2 ? "system" : "mic"); (id == 2 ? system : mic) = state; }
                inputs.push_back(std::move(input));
            }
            if (sources.empty()) { SetEvent(stopEvent); result = 1; }
            else { event({{"type", "ready"}, {"sources", sources}, {"pending", json::array()}, {"sampleRate", 16000}, {"chunkMs", chunkMs}, {"pid", GetCurrentProcessId()}, {"aec", false}, {"micDevice", mic}, {"systemOutputDevice", system}}); WaitForSingleObject(stopEvent, INFINITE); }
            SetEvent(stopEvent); inputs.clear();
        }
        event({{"type", "stopped"}, {"reason", "stdin_closed"}}); return result;
    } catch (const AudioError& error) { event({{"type", "error"}, {"code", "capture_failed"}, {"message", errorMessage(error)}}); return 1; }
    catch (const std::exception& error) { event({{"type", "error"}, {"code", "bad_arguments"}, {"message", error.what()}}); return 2; }
}
