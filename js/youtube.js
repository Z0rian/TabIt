// The YouTube mini player, through YouTube's IFrame Player API. Besides
// playing along, it tells the autoscroll how long the song really is, and can
// drive it: with "follow the video" on, the sheet scrolls with the playback.

let apiPromise = null;

export function loadYouTubeAPI() {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  return (apiPromise ||= new Promise((resolve, reject) => {
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { if (prev) prev(); resolve(window.YT); };
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.async = true;
    s.onerror = () => { apiPromise = null; reject(new Error('Couldn’t load YouTube.')); };
    document.head.append(s);
    setTimeout(() => { if (!window.YT?.Player) { apiPromise = null; reject(new Error('YouTube didn’t load.')); } }, 15000);
  }));
}

export class Player {
  // el: an empty element to hold the player
  constructor(el, videoId, { onReady, onDuration, onState, onError } = {}) {
    this.el = el;
    this.videoId = videoId;
    this.ready = false;
    this.cb = { onReady, onDuration, onState, onError };
    this.durationSent = false;
    loadYouTubeAPI().then(YT => {
      if (this.destroyed) return;
      const holder = document.createElement('div');
      el.replaceChildren(holder);
      this.yt = new YT.Player(holder, {
        videoId,
        width: '100%',
        height: '100%',
        playerVars: { playsinline: 1, rel: 0, modestbranding: 1, origin: location.origin },
        events: {
          onReady: () => {
            this.ready = true;
            this.reportDuration();
            this.cb.onReady?.(this);
          },
          onStateChange: e => {
            this.reportDuration();
            this.cb.onState?.(e.data);
          },
          onError: e => this.cb.onError?.(e.data),
        },
      });
    }).catch(e => this.cb.onError?.(e.message));
  }

  // The duration is known once the video's metadata has loaded; poll briefly.
  reportDuration(tries = 0) {
    if (this.durationSent || !this.ready) return;
    const d = this.duration();
    if (d > 0) {
      this.durationSent = true;
      this.cb.onDuration?.(Math.round(d));
    } else if (tries < 20) {
      setTimeout(() => this.reportDuration(tries + 1), 500);
    }
  }

  duration() { try { return this.yt?.getDuration?.() || 0; } catch { return 0; } }
  time() { try { return this.yt?.getCurrentTime?.() || 0; } catch { return 0; } }
  playing() { try { return this.yt?.getPlayerState?.() === 1; } catch { return false; } }
  play() { try { this.yt?.playVideo?.(); } catch { /* not ready */ } }
  pause() { try { this.yt?.pauseVideo?.(); } catch { /* not ready */ } }
  seekFraction(f) { const d = this.duration(); if (d) try { this.yt.seekTo(f * d, true); } catch { /* ignore */ } }

  destroy() {
    this.destroyed = true;
    try { this.yt?.destroy?.(); } catch { /* ignore */ }
    this.el.replaceChildren();
  }
}
