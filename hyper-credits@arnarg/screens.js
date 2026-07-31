import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import { GEM, formatBalance } from './format.js';

const FRAME_COUNT = 42;
const FRAME_DURATION_MS = 66;

// Owns the animated menu gem: frame loading, the icon actor, and the spin
// timer. The icon lives as long as the main screen, so balance updates never
// destroy it out from under a running animation.
class GemSpinner {
  constructor(dir) {
    this._frames = this._loadFrames(dir);
    this._timerId = 0;

    this.icon = this._frames.length > 0
      ? new St.Icon({
          gicon: this._frames[this._frames.length - 1],
          style_class: 'hc-menu-balance-icon',
          y_align: Clutter.ActorAlign.CENTER,
        })
      : null;
  }

  _loadFrames(dir) {
    const framesDir = dir.get_child('gem');
    const frames = [];
    for (let i = 1; i <= FRAME_COUNT; i++) {
      const file = framesDir.get_child(`frame-${String(i).padStart(2, '0')}.png`);
      if (!file.query_exists(null))
        return [];
      frames.push(new Gio.FileIcon({ file }));
    }
    return frames;
  }

  spinOnce() {
    this.stop();
    if (!this.icon)
      return;
    let index = 0;
    this.icon.gicon = this._frames[0];
    this._timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, FRAME_DURATION_MS, () => {
      index += 1;
      if (index >= this._frames.length) {
        this._timerId = 0;
        return GLib.SOURCE_REMOVE;
      }
      this.icon.gicon = this._frames[index];
      return GLib.SOURCE_CONTINUE;
    });
  }

  stop() {
    if (this._timerId) {
      GLib.Source.remove(this._timerId);
      this._timerId = 0;
    }
  }

  destroy() {
    this.stop();
    this.icon?.destroy();
    this.icon = null;
    this._frames = [];
  }
}

function makeButton(label, onClicked) {
  const button = new St.Button({
    label,
    style_class: 'hc-action-button',
    x_expand: true,
  });
  button.connect('clicked', onClicked);
  return button;
}

function makeIconButton(iconName, onClicked) {
  const button = new St.Button({
    style_class: 'hc-menu-button',
    child: new St.Icon({ icon_name: iconName, style_class: 'popup-menu-icon' }),
  });
  button.connect('clicked', onClicked);
  return button;
}

// A full-width row button with the shell's popup menu item look. Used for
// Cancel on the sign-in screen, which was a standalone PopupMenuItem before
// the screens refactor.
function makeRowButton(label, onClicked) {
  const button = new St.Button({
    label,
    style_class: 'hc-row-button',
    x_expand: true,
  });
  button.connect('clicked', onClicked);
  return button;
}

// Footer with a separator above it, both real sibling menu items like
// before the screens refactor. Refresh and sign-out buttons are optional
// per screen.
function buildFooter({ onRefresh = null, onOpenPrefs, onSignOut = null }) {
  const separator = new PopupMenu.PopupSeparatorMenuItem();

  const item = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false });
  const row = new St.BoxLayout({ x_expand: true, style_class: 'hc-menu-footer-row' });
  item.add_child(row);

  const updatedLabel = new St.Label({
    style_class: 'hc-menu-footer',
    x_expand: true,
    y_align: Clutter.ActorAlign.CENTER,
  });
  row.add_child(updatedLabel);
  if (onRefresh)
    row.add_child(makeIconButton('view-refresh-symbolic', onRefresh));
  row.add_child(makeIconButton('emblem-system-symbolic', onOpenPrefs));
  if (onSignOut)
    row.add_child(makeIconButton('application-exit-rtl-symbolic', onSignOut));
  return { separator, item, updatedLabel };
}

// Each screen's content is one non-reactive menu item wrapping a vertical
// box. The 'hc-screen' class restores the spacing the shell used to provide
// when rows were separate PopupMenuItems.
function makeContentItem() {
  const item = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false });
  const root = new St.BoxLayout({
    vertical: true,
    x_expand: true,
    style_class: 'hc-screen',
  });
  item.add_child(root);
  return { item, root };
}

// Signed-in credits screen. All updates flow through the three setters; no
// widget is ever rebuilt after construction. `items` are the menu items to
// add and visibility-toggle together: content, separator, footer.
export class MainScreen {
  constructor({ extension, onOpenDashboard, onRefresh, onSignOut, onOpenPrefs }) {
    this._spinner = new GemSpinner(extension.dir);

    const { item, root } = makeContentItem();

    root.add_child(new St.Label({
      text: 'Hypercredits Available',
      style_class: 'hc-menu-subtitle',
    }));

    const balanceBox = new St.BoxLayout({
      style_class: 'hc-menu-balance-box',
      x_expand: true,
      y_align: Clutter.ActorAlign.CENTER,
    });
    if (this._spinner.icon) {
      balanceBox.add_child(this._spinner.icon);
    } else {
      balanceBox.add_child(new St.Label({ text: GEM, style_class: 'hc-menu-balance' }));
    }
    this._balanceLabel = new St.Label({
      style_class: 'hc-menu-balance',
      x_expand: true,
      y_align: Clutter.ActorAlign.CENTER,
    });
    balanceBox.add_child(this._balanceLabel);
    root.add_child(balanceBox);

    root.add_child(makeButton('Open Dashboard', onOpenDashboard));

    this._errorLabel = new St.Label({ style_class: 'hc-menu-error', visible: false });
    root.add_child(this._errorLabel);

    this._footer = buildFooter({ onRefresh, onOpenPrefs, onSignOut });

    this._items = [item, this._footer.separator, this._footer.item];
  }

  get items() {
    return this._items;
  }

  get spinner() {
    return this._spinner;
  }

  setBalance(balance) {
    this._balanceLabel.text = balance === null ? '…' : formatBalance(balance, false);
  }

  setError(message) {
    this._errorLabel.text = message ? `⚠ ${message}` : '';
    this._errorLabel.visible = !!message;
  }

  setUpdated(clock) {
    this._footer.updatedLabel.text = clock ? `Updated ${clock}` : '';
  }

  destroy() {
    this._spinner.destroy();
  }
}

export class SignedOutScreen {
  constructor({ onSignIn, onOpenPrefs }) {
    const { item, root } = makeContentItem();

    root.add_child(new St.Label({ text: 'Not signed in' }));
    root.add_child(makeButton('Sign in', onSignIn));

    const footer = buildFooter({ onOpenPrefs });

    this._items = [item, footer.separator, footer.item];
  }

  get items() {
    return this._items;
  }
}

// Device-flow screen. Everything lives inside one content item, including
// Cancel, so this screen is a single menu item with no siblings to manage.
export class SignInScreen {
  constructor({ onCopyCode, onOpenBrowser, onCancel }) {
    const { item, root } = makeContentItem();

    this._statusLabel = new St.Label({ text: 'Starting sign-in…' });
    root.add_child(this._statusLabel);

    this._codeLabel = new St.Label({
      style_class: 'hc-device-code',
      x_align: Clutter.ActorAlign.CENTER,
      x_expand: true,
      visible: false,
    });
    this._codeLabel.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
    root.add_child(this._codeLabel);

    this._hintLabel = new St.Label({ style_class: 'hc-menu-subtitle', visible: false });
    root.add_child(this._hintLabel);

    this._buttonBox = new St.BoxLayout({
      x_expand: true,
      style_class: 'hc-device-buttons',
      visible: false,
    });
    this._buttonBox.add_child(makeButton('Copy code', onCopyCode));
    this._buttonBox.add_child(makeButton('Open browser', onOpenBrowser));
    root.add_child(this._buttonBox);

    this._cancelButton = makeRowButton('Cancel', onCancel);
    this._cancelButton.visible = false;
    root.add_child(this._cancelButton);

    this._items = [item];
  }

  get items() {
    return this._items;
  }

  setDeviceAuth(auth) {
    const ready = !!auth;
    this._statusLabel.text = ready ? 'Waiting for authorization…' : 'Starting sign-in…';
    this._codeLabel.visible = ready;
    this._hintLabel.visible = ready;
    this._buttonBox.visible = ready;
    this._cancelButton.visible = ready;
    if (ready) {
      this._codeLabel.text = auth.userCode;
      this._hintLabel.text = `Open ${auth.verificationUrl} and enter the code.`;
    }
  }
}
