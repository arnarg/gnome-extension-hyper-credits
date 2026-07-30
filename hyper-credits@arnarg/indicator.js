import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import { HyperClient, DeviceFlow, HyperError } from './hyperClient.js';
import { CredentialsStore } from './credentialsStore.js';

const GEM = '\u25C6';

const FRAME_COUNT = 42;
const FRAME_DURATION_MS = 66;
const MENU_GEM_ICON_SIZE = 40;
const PANEL_GEM_ICON_SIZE = 16;

function formatBalance(balance, compact) {
  const options = compact
    ? { notation: 'compact', maximumFractionDigits: 1 }
    : Number.isInteger(balance)
      ? {}
      : { maximumFractionDigits: 2 };
  return new Intl.NumberFormat(undefined, options).format(balance);
}

function formatClock(date) {
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

export const Indicator = GObject.registerClass(
  class Indicator extends PanelMenu.Button {
    _init(extension) {
      super._init(0.5, 'Hyper Credits', false);

      this._extension = extension;
      this._settings = extension.getSettings();
      this._client = new HyperClient({
        apiBaseUrl: this._settings.get_string('api-base-url'),
      });
      this._store = new CredentialsStore();

      this._state = 'loading';
      this._credentials = null;
      this._balance = null;
      this._lastError = null;
      this._lastUpdated = null;
      this._deviceFlow = null;
      this._deviceAuth = null;
      this._destroyed = false;

      this._refreshTimerId = 0;
      this._refreshInFlight = false;
      this._lowBalanceNotified = false;

      this._gemFrames = this._loadGemFrames();
      this._gemIcon = null;
      this._gemAnimTimerId = 0;

      const box = new St.BoxLayout({ style_class: 'hyper-credits-panel-box' });
      const panelGemGicon = this._loadPanelGem();
      if (panelGemGicon) {
        this._gemLabel = new St.Icon({
          gicon: panelGemGicon,
          icon_size: PANEL_GEM_ICON_SIZE,
          y_align: Clutter.ActorAlign.CENTER,
        });
      } else {
        this._gemLabel = new St.Label({
          text: GEM,
          y_align: Clutter.ActorAlign.CENTER,
        });
      }
      this._numberLabel = new St.Label({
        text: '…',
        y_align: Clutter.ActorAlign.CENTER,
      });
      box.add_child(this._gemLabel);
      box.add_child(this._numberLabel);
      this.add_child(box);

      this._rebuildMenu();

      this._settingsSignals = [
        this._settings.connect('changed::refresh-interval',
          () => this._startRefreshLoop()),
        this._settings.connect('changed::display-mode',
          () => this._renderPanelLabel()),
        this._settings.connect('changed::compact-numbers',
          () => this._renderPanelLabel()),
        this._settings.connect('changed::api-base-url', () => {
          this._client.destroy();
          this._client = new HyperClient({
            apiBaseUrl: this._settings.get_string('api-base-url'),
          });
          this._refresh();
        }),
      ];

      this._menuOpenSignal = this.menu.connect('open-state-changed', (_menu, isOpen) => {
        if (isOpen && this._settings.get_boolean('refresh-on-menu-open'))
          this._refresh();
        if (isOpen)
          this._spinGemOnce();
        else
          this._stopGemSpin();
      });

      this.connect('destroy', () => this._onDestroy());

      this._initialize();
    }

    async _initialize() {
      this._credentials = await this._store.load();
      if (this._destroyed)
        return;
      this._state = this._credentials ? 'signedIn' : 'signedOut';
      this._renderPanelLabel();
      this._rebuildMenu();
      this._startRefreshLoop();
      if (this._state === 'signedIn')
        this._refresh();
    }

    _startRefreshLoop() {
      this._stopRefreshLoop();
      if (this._state !== 'signedIn')
        return;
      const interval = this._settings.get_uint('refresh-interval');
      if (interval === 0)
        return;
      this._refreshTimerId = GLib.timeout_add_seconds(
        GLib.PRIORITY_DEFAULT, interval, () => {
          this._refresh();
          return GLib.SOURCE_CONTINUE;
        });
    }

    _stopRefreshLoop() {
      if (this._refreshTimerId) {
        GLib.Source.remove(this._refreshTimerId);
        this._refreshTimerId = 0;
      }
    }

    async _refresh() {
      if (this._destroyed || this._refreshInFlight)
        return;
      if (this._state !== 'signedIn' && this._state !== 'loading')
        return;

      this._refreshInFlight = true;
      try {
        if (!this._credentials)
          this._credentials = await this._store.load();
        if (this._destroyed)
          return;
        if (!this._credentials) {
          this._setSignedOut();
          return;
        }

        let balance;
        try {
          balance = await this._fetchWithCurrentToken();
        } catch (e) {
          if (e instanceof HyperError && e.code === 'unauthorized') {
            await this._refreshTokens();
            balance = await this._fetchWithCurrentToken();
          } else {
            throw e;
          }
        }

        if (this._destroyed)
          return;
        this._onBalance(balance);
      } catch (e) {
        if (this._destroyed)
          return;
        if (e instanceof HyperError && e.code === 'unauthorized') {
          await this._store.clear();
          if (this._destroyed)
            return;
          this._setError('Session expired. Please sign in again.');
          this._setSignedOut();
        } else {
          this._setError(e.message ?? String(e));
        }
      } finally {
        this._refreshInFlight = false;
      }
    }

    async _fetchWithCurrentToken() {
      if (!this._store.isAccessValid(this._credentials))
        await this._refreshTokens();
      return this._client.fetchCredits(this._credentials.access);
    }

    async _refreshTokens() {
      const refreshed = await this._client.exchangeRefreshToken(this._credentials.refresh);
      this._credentials = {
        ...this._credentials,
        access: refreshed.access,
        refresh: refreshed.refresh,
        expires: refreshed.expires,
      };
      await this._store.save(this._credentials);
    }

    _onBalance(balance) {
      this._state = 'signedIn';
      this._balance = balance;
      this._lastError = null;
      this._lastUpdated = formatClock(new Date());
      this._renderPanelLabel();
      this._rebuildMenu();
      this._maybeNotifyLowBalance(balance);
    }

    _setError(message) {
      this._lastError = message;
      if (this._balance === null)
        this._numberLabel.text = '!';
      this._rebuildMenu();
    }

    _setSignedOut() {
      this._state = 'signedOut';
      this._credentials = null;
      this._balance = null;
      this._stopRefreshLoop();
      this._renderPanelLabel();
      this._rebuildMenu();
    }

    _renderPanelLabel() {
      const displayMode = this._settings.get_string('display-mode');
      const compact = this._settings.get_boolean('compact-numbers');

      let text;
      if (this._state === 'signedOut') {
        text = '--';
      } else if (this._balance === null) {
        text = '…';
      } else {
        text = formatBalance(this._balance, compact);
      }

      this._numberLabel.text = text;

      this._gemLabel.visible = displayMode !== 'number-only';
      this._numberLabel.visible = displayMode !== 'gem-only';
    }

    _maybeNotifyLowBalance(balance) {
      const threshold = this._settings.get_uint('low-balance-threshold');
      if (threshold === 0) {
        this._lowBalanceNotified = false;
        return;
      }
      if (balance > threshold) {
        this._lowBalanceNotified = false;
        return;
      }
      if (this._lowBalanceNotified)
        return;

      this._lowBalanceNotified = true;
      Main.notify(
        'Hyper Credits',
        `Balance is low: ${formatBalance(balance, false)} credits remaining.`);
    }

    _startSignIn() {
      if (this._deviceFlow)
        return;

      this._state = 'signingIn';
      this._deviceAuth = null;
      this._rebuildMenu();

      this._deviceFlow = new DeviceFlow(this._client, {
        onUpdate: update => {
          if (update.phase === 'awaiting-user') {
            this._deviceAuth = update.auth;
            this._rebuildMenu();
          }
        },
      });

      this._deviceFlow.run()
        .then(async credentials => {
          this._deviceFlow = null;
          this._deviceAuth = null;
          this._credentials = credentials;
          await this._store.save(credentials);
          if (this._destroyed)
            return;
          this._state = 'signedIn';
          this._lowBalanceNotified = false;
          this._startRefreshLoop();
          this._refresh();
        })
        .catch(e => {
          this._deviceFlow = null;
          this._deviceAuth = null;
          if (this._destroyed)
            return;
          if (e.code === 'cancelled') {
            this._state = this._credentials ? 'signedIn' : 'signedOut';
          } else {
            this._state = 'signedOut';
            this._setError(e.message ?? 'Sign-in failed');
          }
          this._rebuildMenu();
        });
    }

    _cancelSignIn() {
      this._deviceFlow?.cancel();
    }

    async _signOut() {
      this._cancelSignIn();
      await this._store.clear();
      if (this._destroyed)
        return;
      this._setSignedOut();
    }

    _rebuildMenu() {
      this.menu.removeAll();

      if (this._state === 'signingIn') {
        this._buildSignInMenu();
        return;
      } else if (this._state === 'signedOut') {
        this._buildSignedOutMenu();
        return;
      }

      const headerItem = new PopupMenu.PopupMenuItem(
        'Hypercredits Available', { reactive: false, style_class: 'hyper-credits-menu-subtitle' });
      this.menu.addMenuItem(headerItem);

      const balanceItem = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false });
      const balanceBox = new St.BoxLayout({
        style_class: 'hyper-credits-menu-balance-box',
        x_expand: true,
        y_align: Clutter.ActorAlign.CENTER,
      });
      const balanceText = this._balanceText();
      let labelText = balanceText;
      if (this._gemFrames.length > 0 && balanceText.startsWith(GEM)) {
        this._gemIcon = new St.Icon({
          gicon: this._gemFrames[this._gemFrames.length - 1],
          icon_size: MENU_GEM_ICON_SIZE,
          y_align: Clutter.ActorAlign.CENTER,
        });
        balanceBox.add_child(this._gemIcon);
        labelText = balanceText.slice(GEM.length).trimStart();
      } else {
        this._gemIcon = null;
      }
      const balanceLabel = new St.Label({
        text: labelText,
        style_class: 'hyper-credits-menu-balance',
        x_expand: true,
        y_align: Clutter.ActorAlign.CENTER,
      });
      balanceBox.add_child(balanceLabel);
      balanceItem.add_child(balanceBox);
      this.menu.addMenuItem(balanceItem);

      const buttons = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false });
      const buttonBox = new St.BoxLayout({ x_expand: true });

      const dashboardButton = new St.Button({
        label: 'Open Dashboard',
        style_class: 'hyper-credits-action-button',
        x_expand: true,
      });
      dashboardButton.connect('clicked', () => {
        const url = this._client.dashboardUrl(this._credentials?.teamId);
        Gio.AppInfo.launch_default_for_uri(url, null);
      });
      buttonBox.add_child(dashboardButton);

      buttons.add_child(buttonBox);
      this.menu.addMenuItem(buttons);

      if (this._lastError) {
        const errorItem = new PopupMenu.PopupMenuItem(
          `⚠ ${this._lastError}`, { reactive: false, style_class: 'hyper-credits-menu-error' });
        this.menu.addMenuItem(errorItem);
      }

      this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

      this.menu.addMenuItem(this._buildFooter({ refresh: true, signOut: true }));
    }

    _buildSignedOutMenu() {
      const headerItem = new PopupMenu.PopupMenuItem(
        'Not signed in', { reactive: false });
      this.menu.addMenuItem(headerItem);

      const buttons = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false });
      const buttonBox = new St.BoxLayout({ x_expand: true });

      const signInButton = new St.Button({
        label: 'Sign in',
        style_class: 'hyper-credits-action-button',
        x_expand: true,
      });
      signInButton.connect('clicked', () => this._startSignIn());
      buttonBox.add_child(signInButton);

      buttons.add_child(buttonBox);
      this.menu.addMenuItem(buttons);

      this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

      this.menu.addMenuItem(this._buildFooter({ refresh: false, signOut: false }));
    }

    _buildFooter({ refresh, signOut }) {
      const footer = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false });
      const updatedLabel = new St.Label({
        text: this._lastUpdated ? `Updated ${this._lastUpdated}` : '',
        style_class: 'hyper-credits-menu-footer',
        x_expand: true,
        y_align: Clutter.ActorAlign.CENTER,
      });
      footer.add_child(updatedLabel);

      if (refresh)
        footer.add_child(this._makeIconButton('view-refresh-symbolic', () => this._refresh()));
      footer.add_child(this._makeIconButton('emblem-system-symbolic', () => {
        this.menu.close();
        this._extension.openPreferences();
      }));

      if (signOut) {
        footer.add_child(this._makeIconButton('application-exit-rtl-symbolic', () => {
          this.menu.close();
          this._signOut();
        }));
      }

      return footer;
    }

    _balanceText() {
      if (this._balance === null)
        return `${GEM} …`;
      return `${GEM} ${formatBalance(this._balance, false)}`;
    }

    _loadGemFrames() {
      const framesDir = this._extension.dir.get_child('gem');
      const frames = [];
      for (let i = 1; i <= FRAME_COUNT; i++) {
        const file = framesDir.get_child(`frame-${String(i).padStart(2, '0')}.png`);
        if (!file.query_exists(null))
          return [];
        frames.push(new Gio.FileIcon({ file }));
      }
      return frames;
    }

    _loadPanelGem() {
      const file = this._extension.dir.get_child('panel-gem.png');
      if (file.query_exists(null))
        return new Gio.FileIcon({ file });
      return this._gemFrames.length > 0 ? this._gemFrames[0] : null;
    }

    _spinGemOnce() {
      this._stopGemSpin();
      if (!this._gemIcon || this._gemFrames.length === 0)
        return;

      let index = 0;
      this._gemIcon.gicon = this._gemFrames[0];
      this._gemAnimTimerId = GLib.timeout_add(
        GLib.PRIORITY_DEFAULT, FRAME_DURATION_MS, () => {
          index += 1;
          if (index >= this._gemFrames.length) {
            this._gemAnimTimerId = 0;
            return GLib.SOURCE_REMOVE;
          }
          if (this._gemIcon)
            this._gemIcon.gicon = this._gemFrames[index];
          return GLib.SOURCE_CONTINUE;
        });
    }

    _stopGemSpin() {
      if (this._gemAnimTimerId) {
        GLib.Source.remove(this._gemAnimTimerId);
        this._gemAnimTimerId = 0;
      }
    }

    _makeIconButton(iconName, onClicked) {
      const button = new St.Button({
        style_class: 'hyper-credits-menu-button',
        child: new St.Icon({ icon_name: iconName, style_class: 'popup-menu-icon' }),
      });
      button.connect('clicked', onClicked);
      return button;
    }

    _buildSignInMenu() {
      if (!this._deviceAuth) {
        const starting = new PopupMenu.PopupMenuItem(
          'Starting sign-in…', { reactive: false });
        this.menu.addMenuItem(starting);
        return;
      }

      const header = new PopupMenu.PopupMenuItem(
        'Authorize this device', { reactive: false, style_class: 'hyper-credits-menu-subtitle' });
      this.menu.addMenuItem(header);

      const codeItem = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false });
      const codeLabel = new St.Label({
        text: this._deviceAuth.userCode,
        style_class: 'hyper-credits-device-code',
        x_align: Clutter.ActorAlign.CENTER,
        x_expand: true,
      });
      codeLabel.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
      codeItem.add_child(codeLabel);
      this.menu.addMenuItem(codeItem);

      const hint = new PopupMenu.PopupMenuItem(
        `Open ${this._deviceAuth.verificationUrl} and enter the code.`,
        { reactive: false, style_class: 'hyper-credits-menu-subtitle' });
      this.menu.addMenuItem(hint);

      const buttons = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false });
      const buttonBox = new St.BoxLayout({ x_expand: true, style_class: 'hyper-credits-device-buttons' });

      const copyButton = new St.Button({
        label: 'Copy code',
        style_class: 'hyper-credits-action-button',
        x_expand: true,
      });
      copyButton.connect('clicked', () => {
        St.Clipboard.get_default().set_text(
          St.ClipboardType.CLIPBOARD, this._deviceAuth.userCode);
      });
      buttonBox.add_child(copyButton);

      const openButton = new St.Button({
        label: 'Open browser',
        style_class: 'hyper-credits-action-button',
        x_expand: true,
      });
      openButton.connect('clicked', () => {
        Gio.AppInfo.launch_default_for_uri(this._deviceAuth.verificationUrl, null);
      });
      buttonBox.add_child(openButton);

      buttons.add_child(buttonBox);
      this.menu.addMenuItem(buttons);

      const waiting = new PopupMenu.PopupMenuItem(
        'Waiting for authorization…', { reactive: false, style_class: 'hyper-credits-menu-subtitle' });
      this.menu.addMenuItem(waiting);

      const cancel = new PopupMenu.PopupMenuItem('Cancel');
      cancel.connect('activate', () => this._cancelSignIn());
      this.menu.addMenuItem(cancel);
    }

    _onDestroy() {
      this._destroyed = true;
      this._stopRefreshLoop();
      this._stopGemSpin();
      this._cancelSignIn();
      if (this._menuOpenSignal) {
        this.menu.disconnect(this._menuOpenSignal);
        this._menuOpenSignal = 0;
      }
      if (this._settingsSignals) {
        for (const id of this._settingsSignals)
          this._settings.disconnect(id);
        this._settingsSignals = null;
      }
      if (this._client) {
        this._client.destroy();
        this._client = null;
      }
    }
  });
