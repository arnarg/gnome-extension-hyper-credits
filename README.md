# Hyper Credits — GNOME Shell Extension

Shows your remaining [Charm Hyper](https://hyper.charm.land) credits in the
GNOME top bar, next to a gem: `◆ 1,234`.

<p align="center">
  <img alt="Screenshot of the extension" src="screenshot.png">
</p>

* Top bar: gem + balance, formatted with your system locale.
* Dropdown: balance, team name, last refresh time, and actions
  (refresh, preferences, sign out).
* Sign-in uses the same OAuth device flow as
  [`pi-hyper-provider`](https://github.com/charmbracelet/pi-hyper-provider):
  no API keys to copy around. Tokens are stored in GNOME Keyring via
  libsecret.

## Requirements

* GNOME Shell 45 or newer (tested against 50)
* `libsecret` and a running Secret Service (gnome-keyring or compatible)

## Install

```sh
make install
```

This copies the extension to
`~/.local/share/gnome-shell/extensions/hyper-credits@arnarg` and compiles the
GSettings schema. Then:

* On **Wayland**: log out and back in.
* On **X11**: press `Alt+F2`, type `r`, press Enter.

Enable it:

```sh
gnome-extensions enable hyper-credits@arnarg
```

Click the `◆` indicator in the top bar and choose **Sign in to Charm Hyper…**.
The menu will show a code and an **Open browser** button. Authorize the
device, and the balance appears.

## Preferences

Open via the gear icon in the dropdown, or:

```sh
gnome-extensions prefs hyper-credits@arnarg
```

Available options:

| Setting | Default | Description |
| --- | --- | --- |
| Display | Gem and number | What to show in the top bar: gem and number, gem only, or number only |
| Color | All magenta | What to tint magenta: everything, gem only, or nothing |
| Compact numbers | off | Format large balances as `1.2K`, `3.4M` |
| Refresh interval | 5 minutes | How often to poll the credits endpoint |
| Refresh on menu open | on | Also refresh every time the menu opens |
| Low balance threshold | 0 (off) | Notify when balance drops to this many credits |
| API base URL | `https://hyper.charm.land` | Override the API endpoint |

## Layout

```
hyper-credits@arnarg/
├── metadata.json          # extension manifest
├── extension.js           # entry point, wires the indicator into the panel
├── indicator.js           # panel button + dropdown menu + state machine
├── hyperClient.js         # Soup-based Hyper API client + device flow
├── credentialsStore.js    # libsecret-backed credential storage (with file fallback)
├── prefs.js               # libadwaita preferences window
├── stylesheet.css         # panel and menu styles
└── schemas/
    └── org.gnome.shell.extensions.hyper-credits.gschema.xml
```

## How authentication works

1. `POST https://hyper.charm.land/device/auth` returns a device code, user
   code, verification URL, and poll interval.
2. The extension shows the user code and opens the verification URL.
3. It polls `GET /device/auth/<device_code>` until the user authorizes.
4. On success, it exchanges the resulting refresh token at
   `POST /token/exchange` for an access token.
5. Both tokens are stored in GNOME Keyring under the
   `land.charm.Hyper.Credentials` schema. The access token is used for
   `GET /v1/credits`; when it expires, the extension silently refreshes it.
6. Sign-out removes the keyring entry.
