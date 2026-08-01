import GLib from 'gi://GLib';
import Soup from 'gi://Soup';
import Gio from 'gi://Gio';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async');

const DEFAULT_BASE_URL = 'https://hyper.charm.land';
const USER_AGENT = 'hyper-credits-gnome-extension/1';
const FETCH_TIMEOUT_SECONDS = 15;
const TOKEN_EXPIRY_BUFFER_MS = 30_000;
const DEFAULT_DEVICE_POLL_INTERVAL_SECONDS = 5;
const MINIMUM_POLL_INTERVAL_MS = 1000;

export class HyperError extends Error {
  constructor(message, code = 'generic') {
    super(message);
    this.code = code;
  }
}

function baseUrl(override) {
  const raw = (override ?? '').trim() || DEFAULT_BASE_URL;
  return raw.replace(/\/+$/, '');
}

function deviceName() {
  const host = GLib.get_host_name();
  return host ? `GNOME (${host})` : 'GNOME';
}

function newSession() {
  return new Soup.Session({
    timeout: FETCH_TIMEOUT_SECONDS,
    user_agent: USER_AGENT,
  });
}

async function sendJson(session, method, url, body = null, headers = {}) {
  const message = Soup.Message.new(method, url);
  if (!message)
    throw new HyperError(`Could not create request for ${url}`);

  message.get_request_headers().append('Content-Type', 'application/json');
  for (const [name, value] of Object.entries(headers))
    message.get_request_headers().append(name, value);

  if (body !== null) {
    const bytes = new GLib.Bytes(JSON.stringify(body));
    message.set_request_body_from_bytes('application/json', bytes);
  }

  let responseBytes;
  try {
    responseBytes = await session.send_and_read_async(
      message, GLib.PRIORITY_DEFAULT, null);
  } catch (e) {
    throw new HyperError(`Network error reaching ${url}: ${e.message}`, 'network');
  }

  const status = message.get_status();
  const text = new TextDecoder('utf-8').decode(responseBytes.get_data());

  let payload = null;
  if (text.trim().length > 0) {
    try {
      payload = JSON.parse(text);
    } catch {
      throw new HyperError(
        `Invalid JSON from ${url} (HTTP ${status})`, 'bad-response');
    }
  }

  return { status, payload };
}

function parseExpiry(token) {
  const now = Date.now();
  let expiresAt;
  if (typeof token.expires_in === 'number') {
    expiresAt = now + token.expires_in * 1000;
  } else if (typeof token.expires_at === 'number') {
    expiresAt = token.expires_at * 1000;
  } else {
    throw new HyperError('Token exchange response missing expiry', 'bad-response');
  }

  if (expiresAt <= now)
    throw new HyperError('Received an already-expired access token', 'bad-response');

  const buffer = Math.min(TOKEN_EXPIRY_BUFFER_MS, Math.floor((expiresAt - now) / 2));
  return expiresAt - buffer;
}

export class HyperClient {
  constructor({ apiBaseUrl = '' } = {}) {
    this._apiBaseUrlOverride = apiBaseUrl;
    this._session = newSession();
  }

  destroy() {
    if (this._session) {
      this._session.abort();
      this._session = null;
    }
  }

  _url(path) {
    return `${baseUrl(this._apiBaseUrlOverride)}${path}`;
  }

  dashboardUrl(teamId) {
    const base = baseUrl(this._apiBaseUrlOverride);
    return teamId ? `${base}/teams/${encodeURIComponent(teamId)}/dashboard` : base;
  }

  async fetchCredits(accessToken) {
    const { status, payload } = await sendJson(
      this._session, 'GET', this._url('/v1/credits'),
      null, { Authorization: `Bearer ${accessToken}` });

    if (status === 401)
      throw new HyperError('Access token rejected', 'unauthorized');
    if (status === 429)
      throw new HyperError('Rate limited by Hyper, try again later', 'rate-limited');
    if (status !== 200)
      throw new HyperError(`Hyper /credits returned HTTP ${status}`, 'http');

    const balance = payload?.balance;
    if (typeof balance !== 'number')
      throw new HyperError('Hyper /credits response missing balance', 'bad-response');
    return balance;
  }

  async initiateDeviceAuth() {
    const { status, payload } = await sendJson(
      this._session, 'POST', this._url('/device/auth'),
      { device_name: deviceName() });

    if (status !== 200)
      throw new HyperError(`Device auth failed (HTTP ${status})`, 'http');

    const required = ['device_code', 'user_code', 'verification_url', 'expires_in'];
    for (const key of required) {
      if (!payload?.[key])
        throw new HyperError(`Device auth response missing ${key}`, 'bad-response');
    }

    return {
      deviceCode: payload.device_code,
      userCode: payload.user_code,
      verificationUrl: payload.verification_url,
      expiresIn: payload.expires_in,
      interval: typeof payload.interval === 'number'
        ? payload.interval
        : DEFAULT_DEVICE_POLL_INTERVAL_SECONDS,
    };
  }

  async pollDeviceAuthOnce(deviceCode) {
    const url = this._url(`/device/auth/${encodeURIComponent(deviceCode)}`);
    const { status, payload } = await sendJson(this._session, 'GET', url);

    if (payload && typeof payload.refresh_token === 'string') {
      return {
        kind: 'complete',
        refreshToken: payload.refresh_token,
        teamId: payload.team_id ?? null,
        teamName: payload.team_name ?? null,
        userId: payload.user_id ?? null,
      };
    }

    const error = payload?.error;
    if (error === 'authorization_pending')
      return { kind: 'pending' };
    if (error === 'slow_down') {
      return {
        kind: 'slow_down',
        intervalSeconds: typeof payload.interval === 'number' ? payload.interval : null,
      };
    }

    const description = payload?.error_description ?? error ?? `HTTP ${status}`;
    return { kind: 'failed', message: `Authorization failed: ${description}` };
  }

  async exchangeRefreshToken(refreshToken) {
    const { status, payload } = await sendJson(
      this._session, 'POST', this._url('/token/exchange'),
      { refresh_token: refreshToken });

    if (status !== 200) {
      const description = payload?.error_description ?? payload?.error ?? `HTTP ${status}`;
      throw new HyperError(`Token exchange failed: ${description}`, 'unauthorized');
    }

    if (typeof payload?.access_token !== 'string')
      throw new HyperError('Token exchange response missing access_token', 'bad-response');

    return {
      access: payload.access_token,
      refresh: typeof payload.refresh_token === 'string' && payload.refresh_token.length > 0
        ? payload.refresh_token
        : refreshToken,
      expires: parseExpiry(payload),
    };
  }
}

export class DeviceFlow {
  constructor(client, { onUpdate = () => { } } = {}) {
    this._client = client;
    this._onUpdate = onUpdate;
    this._cancelled = false;
    this._timerId = 0;
    this._rejectSleep = null;
  }

  cancel() {
    this._cancelled = true;
    this._clearTimer();
    // Reject any in-flight _sleep so run() unwinds immediately instead of
    // parking on a promise whose timer was just removed.
    this._rejectSleep?.(new HyperError('Sign-in cancelled', 'cancelled'));
    this._rejectSleep = null;
  }

  _clearTimer() {
    if (this._timerId) {
      GLib.Source.remove(this._timerId);
      this._timerId = 0;
    }
  }

  async run() {
    const auth = await this._client.initiateDeviceAuth();
    if (this._cancelled)
      throw new HyperError('Sign-in cancelled', 'cancelled');

    this._onUpdate({ phase: 'awaiting-user', auth });

    const deadline = Date.now() + auth.expiresIn * 1000;
    let intervalMs = Math.max(MINIMUM_POLL_INTERVAL_MS, auth.interval * 1000);
    let slowDowns = 0;

    for (; ;) {
      if (this._cancelled)
        throw new HyperError('Sign-in cancelled', 'cancelled');
      if (Date.now() >= deadline)
        throw new HyperError('Sign-in timed out', 'timeout');

      await this._sleep(Math.min(intervalMs, deadline - Date.now()));

      if (this._cancelled)
        throw new HyperError('Sign-in cancelled', 'cancelled');

      const result = await this._client.pollDeviceAuthOnce(auth.deviceCode);

      if (result.kind === 'complete') {
        const token = await this._client.exchangeRefreshToken(result.refreshToken);
        return {
          access: token.access,
          refresh: token.refresh,
          expires: token.expires,
          teamName: result.teamName,
          teamId: result.teamId,
          userId: result.userId,
        };
      }

      if (result.kind === 'failed')
        throw new HyperError(result.message, 'denied');

      if (result.kind === 'slow_down') {
        slowDowns += 1;
        intervalMs = result.intervalSeconds
          ? Math.max(MINIMUM_POLL_INTERVAL_MS, result.intervalSeconds * 1000)
          : intervalMs + 5000;
      }
    }
  }

  _sleep(ms) {
    this._clearTimer();
    return new Promise((resolve, reject) => {
      this._rejectSleep = reject;
      this._timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.ceil(ms), () => {
        this._timerId = 0;
        this._rejectSleep = null;
        resolve();
        return GLib.SOURCE_REMOVE;
      });
    });
  }
}
