import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

const FRAME_COUNT = 42;
const FRAME_DURATION_MS = 66;

// Owns the animated menu gem: frame loading, the icon actor, and the spin
// timer. The icon lives as long as the indicator, so balance updates never
// destroy it out from under a running animation.
export class GemSpinner {
  constructor(dir, iconSize) {
    this._frames = this._loadFrames(dir);
    this._timerId = 0;

    this.icon = this._frames.length > 0
      ? new St.Icon({
          gicon: this._frames[this._frames.length - 1],
          icon_size: iconSize,
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
