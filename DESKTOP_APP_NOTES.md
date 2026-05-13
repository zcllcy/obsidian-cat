# Desktop Pet Packaging Notes

The current project is the core agent plus browser pet UI. To turn it into a true desktop pet, add one of these wrappers.

## Electron Path

Best when you want a transparent, draggable, always-on-top pet window.

Recommended dependencies:

```powershell
npm install --save-dev electron
```

Main-window settings to use:

```js
const win = new BrowserWindow({
  width: 360,
  height: 420,
  frame: false,
  transparent: true,
  alwaysOnTop: true,
  resizable: false,
  webPreferences: { contextIsolation: true }
});
```

Then load `http://127.0.0.1:4317` after starting `src/node_agent.js` as a child process.

## Tauri Path

Best when you want a smaller native app. More setup is required because Rust tooling is needed.

## Mature Project Ideas To Borrow

- Shimeji-style state machine: idle, walking, sleeping, working, error.
- Electron desktop pet transparency and click-through toggles.
- Local status API between the agent process and UI.
- Tray menu for pause, run now, config, and quit.
