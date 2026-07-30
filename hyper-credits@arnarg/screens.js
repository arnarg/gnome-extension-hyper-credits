import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import St from 'gi://St';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import { GEM, formatBalance } from './format.js';

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
export function buildMainScreen({ spinner, onOpenDashboard, onRefresh, onSignOut, onOpenPrefs }) {
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
  if (spinner.icon) {
    balanceBox.add_child(spinner.icon);
  } else {
    balanceBox.add_child(new St.Label({ text: GEM, style_class: 'hc-menu-balance' }));
  }
  const balanceLabel = new St.Label({
    style_class: 'hc-menu-balance',
    x_expand: true,
    y_align: Clutter.ActorAlign.CENTER,
  });
  balanceBox.add_child(balanceLabel);
  root.add_child(balanceBox);

  root.add_child(makeButton('Open Dashboard', onOpenDashboard));

  const errorLabel = new St.Label({ style_class: 'hc-menu-error', visible: false });
  root.add_child(errorLabel);

  const footer = buildFooter({ onRefresh, onOpenPrefs, onSignOut });

  return {
    items: [item, footer.separator, footer.item],
    setBalance(balance) {
      balanceLabel.text = balance === null ? '…' : formatBalance(balance, false);
    },
    setError(message) {
      errorLabel.text = message ? `⚠ ${message}` : '';
      errorLabel.visible = !!message;
    },
    setUpdated(clock) {
      footer.updatedLabel.text = clock ? `Updated ${clock}` : '';
    },
  };
}

export function buildSignedOutScreen({ onSignIn, onOpenPrefs }) {
  const { item, root } = makeContentItem();

  root.add_child(new St.Label({ text: 'Not signed in' }));
  root.add_child(makeButton('Sign in', onSignIn));

  const footer = buildFooter({ onOpenPrefs });

  return { items: [item, footer.separator, footer.item] };
}

// Device-flow screen. Everything lives inside one content item, including
// Cancel, so this screen is a single menu item with no siblings to manage.
export function buildSignInScreen({ onCopyCode, onOpenBrowser, onCancel }) {
  const { item, root } = makeContentItem();

  const statusLabel = new St.Label({ text: 'Starting sign-in…' });
  root.add_child(statusLabel);

  const codeLabel = new St.Label({
    style_class: 'hc-device-code',
    x_align: Clutter.ActorAlign.CENTER,
    x_expand: true,
    visible: false,
  });
  codeLabel.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
  root.add_child(codeLabel);

  const hintLabel = new St.Label({ style_class: 'hc-menu-subtitle', visible: false });
  root.add_child(hintLabel);

  const buttonBox = new St.BoxLayout({
    x_expand: true,
    style_class: 'hc-device-buttons',
    visible: false,
  });
  buttonBox.add_child(makeButton('Copy code', onCopyCode));
  buttonBox.add_child(makeButton('Open browser', onOpenBrowser));
  root.add_child(buttonBox);

  const cancelButton = makeRowButton('Cancel', onCancel);
  cancelButton.visible = false;
  root.add_child(cancelButton);

  return {
    items: [item],
    setDeviceAuth(auth) {
      const ready = !!auth;
      statusLabel.text = ready ? 'Waiting for authorization…' : 'Starting sign-in…';
      codeLabel.visible = ready;
      hintLabel.visible = ready;
      buttonBox.visible = ready;
      cancelButton.visible = ready;
      if (ready) {
        codeLabel.text = auth.userCode;
        hintLabel.text = `Open ${auth.verificationUrl} and enter the code.`;
      }
    },
  };
}
