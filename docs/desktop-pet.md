# Desktop pet

The Chumi desktop app on macOS and Windows can keep a small Chumi in the corner of your screen, with a toolbar and the latest answer under
it, so you can follow a meeting without switching to Chumi's window. It floats above other windows, including a
full-screen Zoom call.

Turn it on or off in **Settings → Desktop pet**, or with Window → Desktop Pet in the macOS menu bar (**窗口 → 桌宠** on Windows).

## Settings → Desktop pet

| Setting | Options |
| --- | --- |
| Show the desktop pet | On by default |
| Size | 50–200 %, by slider or typed: the character, toolbar and cards together |
| Show under the pet | The toolbar; the cards (the latest answer, the recent answers, or none); and which cards, by tag |
| Speech bubbles | What it talks about, by tag: 会议内容, 发散提问, 背景, 总结, and 闲聊 (greetings and reactions). It always tells you when something fails |
| Show the pet in screen shares and recordings | Off by default (see below) |
| Low-key while recording | Off by default: an idle-looking pet with a soft star glow; plain toolbar icons, details on hover |
| Move it back to the corner | If you lost it on another display |

The tags are the same as the filter chips above the cards in Chumi's window. The pet's own controls change the same
settings: ⌄ switches between the latest and the recent answers, the chips above its recent answers switch tags, and
the right-click menu's *Pet Only* and *Hide Desktop Pet* turn off the toolbar and cards, or the pet.

## The toolbar

| Button | What it does |
| --- | --- |
| Sound bars | No meeting: **Quick start** (the same as the quick-start shortcut, with the type and source from Settings → Quick start) |
| ● 12:34 / ▶ 12:34 | During a meeting: its time. Click to pause or resume |
| ✦ | **Catch me up** on the last 2 minutes |
| ✎ | **Ask** about the meeting: a box opens under the toolbar, Enter sends, Esc closes. Works for the latest meeting too |
| ■ | **End meeting**. Click twice: the first click asks *End meeting?* |
| ⌄ | During a meeting: the recent answers (up to 6) instead of only the latest. Without one: the last meeting's answers |
| ↗ Codex app | After the meeting, once its handoff is confirmed in Chumi: **continue** it in a coding agent, where you last chose in the handoff dialog's *Continue in* (Codex app unless you picked another; the button names it). The pet then says what it did. With *Copy instructions* chosen it opens the handoff in Chumi instead, since copying needs Chumi's window. Reviewing and confirming always happen in Chumi |

Hover a button for its name. Without a meeting, the toolbar shows only Quick start, Ask, the recent list and, once the
meeting's handoff is confirmed, Continue. The toolbar can be turned off in Settings.

## The cards

During a meeting, the card under the toolbar shows its newest catch-up, answer, explanation or summary, with the same
titles as Chumi's window (*回顾 · 最近 2 分钟*, *解释：KV cache*) and a dot in its tag's colour. With no meeting on,
nothing shows under the toolbar; ⌄ then shows the last meeting's answers, and so do a question you ask and the
pet's *summary ready* bubble.

- A spinner means it is still being written. The text streams in as it arrives.
- In the recent list, chips with counts filter the cards by tag, as in Chumi's window. A card being written, or one
  you asked for or opened, stays whatever the filter.
- The list stops at the bottom of the screen; older cards that would not fit are left out.
- Click a card to read all of it; click it again to fold it. Drag over its text, or double-click a word, to select
  instead.
- Time chips such as `2:41` open the meeting in Chumi's window at that moment. **Open in Chumi** opens the card's
  passage.
- Background recaps stay in Chumi's window; the pet lists only what you asked for, explanations and the summary.

## The character

| When | Chumi |
| --- | --- |
| The app starts | waves: *Hi! I'm Chumi.* |
| A meeting records | perks up its ears; the bubble beside it follows the room's audio, and it jots a note for each new line |
| An answer is on its way | thinks (the star on its head spins), then hops: *Here's what you missed!* Click the bubble to open that card |
| A new term was explained automatically | *New term: KV cache* |
| The meeting ends | waves, then celebrates when the summary is written |
| Something failed | looks worried. Click the bubble to open Chumi and see why |
| Nothing has happened for 90 seconds and no meeting is on | falls asleep, and wakes when the cursor comes near |

Its eyes follow the cursor, and rubbing the cursor over its head pets it. Click it for a hop; double-click opens
Chumi's window. Drag it by the character to move everything; it stays where you drop it. It speaks Chumi's interface
language (Settings → Language).

**Right-click** (or control-click): *Catch Me Up*, *Open Chumi*, *Pet Only* (hide the toolbar and cards; *Show
Toolbar* brings them back) and *Hide Desktop Pet*. Bring a hidden pet back in Settings → Desktop pet or with
Window → Desktop Pet.

## Staying out of the way

- Clicks only land on Chumi, its toolbar, its cards and its bubble. Everywhere else in its window they pass through
  to whatever is underneath.
- It never takes focus, so clicking it does not pull you out of your call or slides. The one exception is the ask
  box, which takes the keyboard while it is open and hands it back when it closes.
- On macOS, ⌘H hides Chumi's window but leaves the pet. On Windows, minimizing the main window leaves the pet; closing the main window exits Chumi.
- When the cards grow near the bottom of the screen, the panel slides up to fit and returns when they shrink.
- **Screen sharing:** by default the pet is left out of screen shares and recordings, so a shared screen in a lab
  meeting does not show *Here's what you missed!*. macOS honours this for most capture tools, but some newer ones may
  still capture it. To record the pet on purpose, turn on *Show the pet in screen shares and recordings*.
- **Low-key while recording:** the pet looks idle throughout a live meeting, including pauses, with a slow, soft
  star glow so you can tell it is listening. No listening pose, sound bars, note-taking or meeting announcements;
  late answers and the final summary stay quiet too, with a neutral *Ready* bubble. The toolbar keeps the same
  neutral icons and layout before, during and after a meeting, with details on hover and two clicks to end.
  Catch-up progress appears only in its tooltip. Continue handoffs from Chumi's window in this mode.
  Cards appear only when you open them with ⌄, a bubble or a question; automatic explanations and the empty card
  stay hidden. While the pet is shown, start/pause/resume shortcut notifications are skipped; errors and busy
  notices still show. You can switch this on or off during a meeting. Chumi still records and transcribes as usual;
  its window, the system microphone indicator and screen-share settings do not change. Recording people still
  needs their consent.

On Windows, capture visibility uses Electron's [content protection](https://www.electronjs.org/docs/latest/api/browser-window#winsetcontentprotectionenable) (`WDA_EXCLUDEFROMCAPTURE`). Ordinary interaction leaves the foreground window focused; opening Ask temporarily enables keyboard focus. Position is remembered and restored to the primary display if its previous display is removed.

## How it works

| Piece | What it does |
| --- | --- |
| `native/app/PetPanel.swift` | A borderless, non-activating, transparent panel that shows `pet.html` at the page's height and the size from Settings (`pageZoom`). It drags the character, forwards taps, builds the right-click menu, gives the toolbar and cards normal web clicks, and turns click-through on and off as the cursor moves |
| `native/windows/desktop/pet-panel.cjs`, `pet-preload.cjs` | The Electron window for the same page: isolated zoom, cursor and drag events, click-through regions, native menu, capture protection and a narrow IPC bridge. The page and the main window share the saved continuation destination |
| `pet` in Settings (`server/settings.ts`) | On/off, size, toolbar, cards, bubbles and screen shares. The page reads them and tells the panel whether to show, its zoom and whether capture may see it, so Settings, the pet's menu and Window → Desktop Pet stay in step |
| `web/pet.html`, `web/src/pet/main.ts` | The page: subscribes to `/api/events` (`live`, `level`, `segment`, `ai`, `ai-delta`, `notice`, `session-ended`, `session-deleted`) and tells the panel its height and clickable areas |
| `web/src/pet/companion.ts`, `recent.ts`, `pet.css` | The toolbar, ask box and cards. They call the same endpoints as Chumi's window (`/api/session/quick-start`, `pause`, `resume`, `end`, `/api/ai/catchup`, `/api/ai/ask`) |
| `web/src/pet/brain.ts` | Turns events into a mood and a line to say. No DOM, tested in `tests/pet-brain.test.ts` (and `recent.ts` in `tests/pet-recent.test.ts`) |
| `web/src/pet/rig.ts`, `view.ts` | The character (SVG) and its animation. Every frame is a function of time, so the promo video renders the same character |

To work on the page without building the app, run the server and open `http://127.0.0.1:4777/pet.html` in a browser.
There the page follows the mouse itself: click the character to tap it, right-click for a catch-up.

Chumi.app attaches to a Chumi server that is already running on port 4777. To try a new build, quit the Chumi you
normally use first; otherwise the new app shows the old server's pages, and without its `pet.html` no pet appears.

## Promo video

```sh
node scripts/record-footage.ts --lang zh    # first: record the real pet (and window) while answers stream in
node scripts/make-pet-video.ts              # 中文 → docs/assets/chumi-pet-zh.mp4
node scripts/make-pet-video.ts --lang en    # English → docs/assets/chumi-pet.mp4
node scripts/make-pet-video.ts --preview    # still frames only, for checking layout
```

The scene is `docs/video/pet/promo.html`. On the desk it plays live footage of the real pet page: the recorder plays
the sample meeting through a throwaway server, clicks the pet's real toolbar, types into its ask box, and screencasts
the page (zoomed 3×, transparent background) while Codex's answers stream in. The intro and outro draw the same
character with its own code. Vite serves the page so it can import the pet's TypeScript, headless Chrome renders each
frame, and the music (`scripts/soundtrack.ts`) and sound effects are synthesised (no third-party audio). A full-quality
1080p copy goes to `dist/video/`.
