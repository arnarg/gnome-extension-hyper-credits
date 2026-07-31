import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const INTERVALS = [
  { label: '30 seconds', value: 30 },
  { label: '1 minute', value: 60 },
  { label: '5 minutes', value: 300 },
  { label: '15 minutes', value: 900 },
];

const DISPLAY_MODES = [
  { label: 'Gem and number', value: 'both' },
  { label: 'Gem only', value: 'gem-only' },
  { label: 'Number only', value: 'number-only' },
];

// Idle delay before committing the API base URL entry. The row emits
// 'changed' on every keystroke; committing each one would tear down and
// rebuild the extension's HTTP session (and refetch) per character.
const URL_COMMIT_DELAY_MS = 600;

export default class HyperCreditsPreferences extends ExtensionPreferences {
  fillPreferencesWindow(window) {
    const settings = this.getSettings();

    window.set_default_size(520, 640);

    const appearancePage = new Adw.PreferencesPage({
      title: 'Appearance',
      icon_name: 'applications-graphics-symbolic',
    });
    window.add(appearancePage);
    this._buildAppearanceGroup(appearancePage, settings);

    const behaviorPage = new Adw.PreferencesPage({
      title: 'Behavior',
      icon_name: 'preferences-system-symbolic',
    });
    window.add(behaviorPage);
    this._buildBehaviorGroup(behaviorPage, settings);
    this._buildAdvancedGroup(behaviorPage, settings);
  }

  _buildAppearanceGroup(page, settings) {
    const group = new Adw.PreferencesGroup({
      title: 'Top bar',
      description: 'How the credit balance is shown in the panel',
    });
    page.add(group);

    const displayRow = new Adw.ComboRow({
      title: 'Display',
      subtitle: 'What to show in the top bar',
    });
    const displayModel = new Gtk.StringList();
    for (const entry of DISPLAY_MODES)
      displayModel.append(entry.label);
    displayRow.model = displayModel;

    const currentDisplay = settings.get_string('display-mode');
    const currentDisplayIndex = Math.max(0,
      DISPLAY_MODES.findIndex(e => e.value === currentDisplay));
    displayRow.selected = currentDisplayIndex;
    displayRow.connect('notify::selected', () => {
      const entry = DISPLAY_MODES[displayRow.selected];
      if (entry)
        settings.set_string('display-mode', entry.value);
    });
    group.add(displayRow);

    const compactRow = new Adw.SwitchRow({
      title: 'Compact numbers',
      subtitle: 'Format large balances as 1.2K, 3.4M, etc.',
    });
    settings.bind('compact-numbers', compactRow, 'active', Gio.SettingsBindFlags.DEFAULT);
    group.add(compactRow);
  }

  _buildBehaviorGroup(page, settings) {
    const group = new Adw.PreferencesGroup({
      title: 'Refreshing',
      description: 'When to fetch the latest balance',
    });
    page.add(group);

    const intervalRow = new Adw.ComboRow({
      title: 'Refresh interval',
      subtitle: 'How often to poll the Hyper credits endpoint',
    });
    const intervalModel = new Gtk.StringList();
    for (const entry of INTERVALS)
      intervalModel.append(entry.label);
    intervalRow.model = intervalModel;

    const currentInterval = settings.get_uint('refresh-interval');
    const currentIndex = Math.max(0,
      INTERVALS.findIndex(e => e.value === currentInterval));
    intervalRow.selected = currentIndex;
    intervalRow.connect('notify::selected', () => {
      const entry = INTERVALS[intervalRow.selected];
      if (entry)
        settings.set_uint('refresh-interval', entry.value);
    });
    group.add(intervalRow);

    const onOpenRow = new Adw.SwitchRow({
      title: 'Refresh when menu opens',
      subtitle: 'Fetch the balance every time the dropdown is opened',
    });
    settings.bind('refresh-on-menu-open', onOpenRow, 'active',
      Gio.SettingsBindFlags.DEFAULT);
    group.add(onOpenRow);

    const notifyGroup = new Adw.PreferencesGroup({
      title: 'Notifications',
    });
    page.add(notifyGroup);

    const thresholdRow = new Adw.SpinRow({
      title: 'Low balance threshold',
      subtitle: 'Notify when the balance drops at or below this many credits. 0 disables.',
      adjustment: new Gtk.Adjustment({
        lower: 0,
        upper: 1_000_000,
        step_increment: 10,
        page_increment: 100,
        value: settings.get_uint('low-balance-threshold'),
      }),
    });
    thresholdRow.connect('notify::value', () => {
      settings.set_uint('low-balance-threshold',
        Math.max(0, Math.floor(thresholdRow.value)));
    });
    notifyGroup.add(thresholdRow);
  }

  _buildAdvancedGroup(page, settings) {
    const group = new Adw.PreferencesGroup({
      title: 'Advanced',
    });
    page.add(group);

    const urlRow = new Adw.EntryRow({
      title: 'API base URL',
    });
    urlRow.text = settings.get_string('api-base-url');

    // Debounce: reset a short timer on each keystroke and commit the trimmed
    // text only once typing pauses, so a single settings change (and thus a
    // single session rebuild + refetch) happens per edit, not per character.
    let commitTimerId = 0;
    const commitUrl = () => {
      commitTimerId = 0;
      const value = urlRow.text.trim();
      if (value !== settings.get_string('api-base-url'))
        settings.set_string('api-base-url', value);
      return GLib.SOURCE_REMOVE;
    };
    urlRow.connect('changed', () => {
      if (commitTimerId)
        GLib.Source.remove(commitTimerId);
      commitTimerId = GLib.timeout_add(
        GLib.PRIORITY_DEFAULT, URL_COMMIT_DELAY_MS, commitUrl);
    });
    // Flush any pending edit when the row is hidden (window closed or page
    // switched) so a fast final keystroke isn't lost. Use 'unmap' rather than
    // 'destroy': the text is still readable here, unlike during disposal.
    urlRow.connect('unmap', () => {
      if (commitTimerId) {
        GLib.Source.remove(commitTimerId);
        commitTimerId = 0;
        commitUrl();
      }
    });
    group.add(urlRow);
  }
}
