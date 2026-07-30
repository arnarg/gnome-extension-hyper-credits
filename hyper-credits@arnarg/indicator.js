import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

import { HyperClient, DeviceFlow, HyperError } from './hyperClient.js';
import { CredentialsStore } from './credentialsStore.js';
import { GemSpinner } from './gemSpinner.js';
import { buildMainScreen, buildSignedOutScreen, buildSignInScreen } from './screens.js';
import { formatBalance, formatClock } from './format.js';

const MENU_GEM_ICON_SIZE = 40;
const PANEL_GEM_ICON_SIZE = 16;

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

      this._state = 'signedOut';
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

      // ---- panel: built once; only text and visibility ever change ----
      const box = new St.BoxLayout({ style_class: 'hc-panel-box' });
      this._panelGem = new St.Icon({
        gicon: new Gio.FileIcon({ file: extension.dir.get_child('panel-gem.png') }),
        icon_size: PANEL_GEM_ICON_SIZE,
        y_align: Clutter.ActorAlign.CENTER,
      });
      this._numberLabel = new St.Label({
        text: '--',
        y_align: Clutter.ActorAlign.CENTER,
      });
      box.add_child(this._panelGem);
      box.add_child(this._numberLabel);
      this.add_child(box);

      // ---- menu screens: built once, swapped by visibility ----
      this._spinner = new GemSpinner(extension.dir, MENU_GEM_ICON_SIZE);
      const closeAnd = fn => () => {
        this.menu.close();
        fn();
      };

      this._mainScreen = buildMainScreen({
        spinner: this._spinner,
        onOpenDashboard: () => this._openDashboard(),
        onRefresh: () => this._refresh(),
        onSignOut: closeAnd(() => this._signOut()),
        onOpenPrefs: closeAnd(() => extension.openPreferences()),
      });
      this._signedOutScreen = buildSignedOutScreen({
        onSignIn: () => this._startSignIn(),
        onOpenPrefs: closeAnd(() => extension.openPreferences()),
      });
      this._signInScreen = buildSignInScreen({
        onCopyCode: () => this._copyDeviceCode(),
        onOpenBrowser: () => this._openVerificationUrl(),
        onCancel: () => this._cancelSignIn(),
      });

      this._screens = {
        signedIn: this._mainScreen.items,
        signedOut: this._signedOutScreen.items,
        signingIn: this._signInScreen.items,
      };
      for (const items of Object.values(this._screens))
        for (const item of items)
          this.menu.addMenuItem(item);
      this._applyState();

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
        this._settings.connect('changed::debug-balance', () => {
          if (this._applyDebugBalance())
            return;
          // Debug mode was just turned off: re-run normal initialization.
          this._initialize();
        }),
      ];

      this._menuOpenSignal = this.menu.connect('open-state-changed', (_menu, isOpen) => {
        if (isOpen && this._settings.get_boolean('refresh-on-menu-open'))
          this._refresh();
        if (isOpen && this._state === 'signedIn')
          this._spinner.spinOnce();
        else
          this._spinner.stop();
      });

      this.connect('destroy', () => this._onDestroy());

      this._initialize();
    }

    async _initialize() {
      // Debug mode: render a fixed balance without sign-in or network, for
      // development and theme testing.
      if (this._applyDebugBalance())
        return;

      this._credentials = await this._store.load();
      if (this._destroyed)
        return;
      if (this._credentials) {
        this._state = 'signedIn';
        this._applyState();
        this._startRefreshLoop();
        this._refresh();
      } else {
        this._applyState();
      }
    }

    // Pushes the debug-balance setting through the normal render path when
    // it is >= 0. Returns true while debug mode is active so callers skip
    // credentials, refresh loops, and fetches.
    _applyDebugBalance() {
      const debugBalance = this._settings.get_int('debug-balance');
      if (debugBalance < 0)
        return false;
      this._state = 'signedIn';
      this._onBalance(debugBalance);
      return true;
    }

    _startRefreshLoop() {
      this._stopRefreshLoop();
      if (this._state !== 'signedIn')
        return;
      if (this._settings.get_int('debug-balance') >= 0)
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
      if (this._state !== 'signedIn')
        return;
      if (this._settings.get_int('debug-balance') >= 0)
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
          this._setSignedOut();
          this._setError('Session expired. Please sign in again.');
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

    // Single entry point for pushing current state into the widgets. Screen
    // visibility follows _state; the visible screen's setters receive the
    // current data. No actor is ever rebuilt after _init.
    _applyState() {
      for (const [name, items] of Object.entries(this._screens))
        for (const item of items)
          item.visible = name === this._state;

      if (this._state === 'signedIn') {
        this._mainScreen.setBalance(this._balance);
        this._mainScreen.setError(this._lastError);
        this._mainScreen.setUpdated(this._lastUpdated);
      } else if (this._state === 'signingIn') {
        this._signInScreen.setDeviceAuth(this._deviceAuth);
      }
      this._renderPanelLabel();
    }

    _onBalance(balance) {
      this._state = 'signedIn';
      this._balance = balance;
      this._lastError = null;
      this._lastUpdated = formatClock(new Date());
      this._applyState();
      this._maybeNotifyLowBalance(balance);
    }

    _setError(message) {
      this._lastError = message;
      this._applyState();
    }

    _setSignedOut() {
      this._state = 'signedOut';
      this._credentials = null;
      this._balance = null;
      this._lastError = null;
      this._stopRefreshLoop();
      this._applyState();
    }

    _renderPanelLabel() {
      const displayMode = this._settings.get_string('display-mode');
      const compact = this._settings.get_boolean('compact-numbers');

      let text;
      if (this._state !== 'signedIn') {
        text = '--';
      } else if (this._balance === null) {
        text = this._lastError ? '!' : '…';
      } else {
        text = formatBalance(this._balance, compact);
      }

      this._numberLabel.text = text;

      this._panelGem.visible = displayMode !== 'number-only';
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
      this._applyState();

      this._deviceFlow = new DeviceFlow(this._client, {
        onUpdate: update => {
          if (update.phase === 'awaiting-user') {
            this._deviceAuth = update.auth;
            this._applyState();
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
          this._applyState();
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
            this._applyState();
          } else {
            this._setSignedOut();
            this._setError(e.message ?? 'Sign-in failed');
          }
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

    _openDashboard() {
      const url = this._client.dashboardUrl(this._credentials?.teamId);
      this.menu.close();
      Gio.AppInfo.launch_default_for_uri(url, null);
    }

    _copyDeviceCode() {
      if (!this._deviceAuth)
        return;
      St.Clipboard.get_default().set_text(
        St.ClipboardType.CLIPBOARD, this._deviceAuth.userCode);
    }

    _openVerificationUrl() {
      if (!this._deviceAuth)
        return;
      Gio.AppInfo.launch_default_for_uri(this._deviceAuth.verificationUrl, null);
    }

    _onDestroy() {
      this._destroyed = true;
      this._stopRefreshLoop();
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
      if (this._spinner) {
        this._spinner.destroy();
        this._spinner = null;
      }
      if (this._client) {
        this._client.destroy();
        this._client = null;
      }
    }
  });
