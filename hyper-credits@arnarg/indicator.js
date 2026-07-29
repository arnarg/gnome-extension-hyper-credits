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
const MAGENTA = '#ff60ff';

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

        const box = new St.BoxLayout({ style_class: 'hyper-credits-panel-box' });
        this._gemLabel = new St.Label({
            text: GEM,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._numberLabel = new St.Label({
            text: '…',
            y_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(this._gemLabel);
        box.add_child(this._numberLabel);
        this.add_child(box);

        this._applyLabelStyle();
        this._rebuildMenu();

        this._settingsSignals = [
            this._settings.connect('changed::refresh-interval',
                () => this._startRefreshLoop()),
            this._settings.connect('changed::display-mode',
                () => this._renderPanelLabel()),
            this._settings.connect('changed::compact-numbers',
                () => this._renderPanelLabel()),
            this._settings.connect('changed::color-mode',
                () => this._applyLabelStyle()),
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

        this._applyLabelStyle();
    }

    _applyLabelStyle() {
        const colorMode = this._settings.get_string('color-mode');
        const gemStyle = (colorMode === 'all' || colorMode === 'gem-only')
            ? `color: ${MAGENTA};` : null;
        const numberStyle = colorMode === 'all'
            ? `color: ${MAGENTA};` : null;
        this._gemLabel.style = gemStyle;
        this._numberLabel.style = numberStyle;
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
        }

        const balanceItem = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false });
        const balanceLabel = new St.Label({
            text: this._balanceText(),
            style_class: 'hyper-credits-menu-balance',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        balanceItem.add_child(balanceLabel);
        this.menu.addMenuItem(balanceItem);

        if (this._credentials?.teamName) {
            const teamItem = new PopupMenu.PopupMenuItem(
                this._credentials.teamName, { reactive: false, style_class: 'hyper-credits-menu-subtitle' });
            this.menu.addMenuItem(teamItem);
        }

        if (this._lastError) {
            const errorItem = new PopupMenu.PopupMenuItem(
                `⚠ ${this._lastError}`, { reactive: false, style_class: 'hyper-credits-menu-error' });
            this.menu.addMenuItem(errorItem);
        }

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const footer = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false });
        const updatedLabel = new St.Label({
            text: this._lastUpdated ? `Updated ${this._lastUpdated}` : '',
            style_class: 'hyper-credits-menu-footer',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        footer.add_child(updatedLabel);

        footer.add_child(this._makeIconButton('view-refresh-symbolic', () => this._refresh()));
        footer.add_child(this._makeIconButton('emblem-system-symbolic', () => {
            this.menu.close();
            this._extension.openPreferences();
        }));

        if (this._state === 'signedIn') {
            footer.add_child(this._makeIconButton('application-exit-rtl-symbolic', () => {
                this.menu.close();
                this._signOut();
            }));
        }

        this.menu.addMenuItem(footer);

        if (this._state === 'signedOut') {
            const signIn = new PopupMenu.PopupMenuItem('Sign in to Charm Hyper…');
            signIn.connect('activate', () => this._startSignIn());
            this.menu.addMenuItem(signIn, 0);
        }
    }

    _balanceText() {
        if (this._state === 'signedOut')
            return `${GEM} Not signed in`;
        if (this._balance === null)
            return `${GEM} …`;
        return `${GEM} ${formatBalance(this._balance, false)} credits`;
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
