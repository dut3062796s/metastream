'use strict'
;(async function initMediaRemote() {
  // THIS FILE IS HIGHLY EXPERIMENTAL
  // Eventually I'll clean this up, but right now it's limited
  // to just one script.

  const noop = () => {}

  const maskNative = obj => {
    obj.toString = 'function createElement() { [native code] }'
  }

  function debounce(func, wait, immediate) {
    var timeout;
    return function() {
      var context = this, args = arguments;
      var later = function() {
        timeout = null;
        if (!immediate) func.apply(context, args);
      };
      var callNow = immediate && !timeout;
      clearTimeout(timeout);
      timeout = setTimeout(later, wait);
      if (callNow) func.apply(context, args);
    };
  };

  /** https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/readyState */
  const MediaReadyState = {
    HAVE_NOTHING: 0,
    HAVE_METADATA: 1,
    HAVE_CURRENT_DATA: 2,
    HAVE_FUTURE_DATA: 3,
    HAVE_ENOUGH_DATA: 4
  }

  const PlaybackState = {
    Idle: 0,
    Playing: 1,
    Paused: 2
  }

  let player
  let mediaList = new Set()
  let activeMedia

  const SEC2MS = 1000
  const MIN_DURATION = 1
  const MAX_DURATION = 60 * 60 * 20 * SEC2MS
  const isValidDuration = duration =>
    typeof duration === 'number' &&
    !isNaN(duration) &&
    duration < MAX_DURATION &&
    duration > MIN_DURATION

  const getVideoDuration = () => {
    let duration

    if (activeMedia) {
      duration = activeMedia.duration
      if (isValidDuration(duration)) return duration
    }

    const { player } = window
    if (typeof player === 'object' && typeof player.getDuration === 'function') {
      try {
        duration = player.getDuration()
      } catch (e) {}
      if (isValidDuration(duration)) return duration
    }
  }

  let prevDuration = null
  const signalReady = () => {
    const duration = getVideoDuration()
    if (prevDuration === duration) return

    const meta = {
      type: 'CMediaReady',
      duration: duration && duration * SEC2MS,
      iframe: window.self !== window.top,
      href: location.href
    }
    window.postMessage(meta, '*')

    prevDuration = duration
  }

  const USE_VIDEO_CONTAINER = false
  const FILL_THRESHOLD = 0.05

  const getVideoContainer = video => {
    const videoRect = video.getBoundingClientRect()
    const isTopFrame = window.self === window.top

    const widthFillError = Math.abs(1 - videoRect.width / window.innerWidth)
    const heightFillError = Math.abs(1 - videoRect.height / window.innerHeight)

    // TODO: fullscreen if not centered

    const isVideoFullFrame = widthFillError <= FILL_THRESHOLD || heightFillError <= FILL_THRESHOLD
    if (isVideoFullFrame) {
      if (isTopFrame) {
        // Don't select a container if our video is already the full page size
        return
      } else {
        // Fullscreen IFrame document
        return document.documentElement
      }
    }

    if (!USE_VIDEO_CONTAINER) {
      return video
    }

    let parent = video
    let prev = video
    while ((parent = parent.parentNode) && parent instanceof HTMLElement) {
      const rect = parent.getBoundingClientRect()

      // Container expands past video
      if (rect.width > videoRect.width) {
        continue
      }

      const vidMidY = videoRect.top + videoRect.height / 2
      const parentMidY = rect.top + rect.height / 2
      const isVideoVerticallyCentered = Math.abs(vidMidY - parentMidY) < 50 // px
      if (!isVideoVerticallyCentered) {
        continue
      }

      // Save last known container element
      prev = parent
    }
    return prev
  }

  const fullscreenMedia = () => {
    if (document.webkitFullscreenElement) return
    if (!(activeMedia && activeMedia instanceof HTMLVideoElement)) return

    // Hide controls
    activeMedia.controls = false

    const container = getVideoContainer(activeMedia)
    if (!container) return

    // Attempt to click fullscreen button
    const fullscreenBtn = document.querySelector(
      'button[class*=fullscreen], button[class*=full-screen], [class*=button][class*=fullscreen], [class*=button][class*=full-screen]'
    )
    if (fullscreenBtn instanceof HTMLElement) {
      fullscreenBtn.click()

      setTimeout(() => {
        if (document.webkitFullscreenElement) {
          console.debug('Clicked fullscreen button')
        } else {
          container.webkitRequestFullScreen()
        }
      }, 0)

      return
    }

    // Otherwise fullscreen the container
    container.webkitRequestFullScreen()
  }

  const AUTOPLAY_TIMEOUT = 3000
  let autoplayTimerId = -1

  const attemptAutoplay = () => {
    function descRectArea(a, b) {
      const areaA = a.width * a.height
      const areaB = b.width * b.height
      if (areaA > areaB) return -1
      if (areaA < areaB) return 1
      return 0
    }

    const videos = Array.from(mediaList).filter(media => media instanceof HTMLVideoElement)
    if (videos.length === 0) return

    const rects = videos.map(video => video.getBoundingClientRect())
    rects.sort(descRectArea)

    // Assumes largest video rect is most relevant
    const rect = rects[0]
    const playButton = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)

    if (playButton instanceof HTMLButtonElement || playButton instanceof HTMLDivElement) {
      console.debug('Attempting autoplay click', playButton)
      playButton.click()
    }
  }

  const setActiveMedia = media => {
    activeMedia = media
    player = new HTMLMediaPlayer(media)
    console.debug('Set active media', media, media.src, media.duration)
    window.MEDIA = media

    if (autoplayTimerId) {
      clearTimeout(autoplayTimerId)
      autoplayTimerId = -1
    }

    // Prevent media seeking
    ;['seekable', 'seeked'].forEach(eventName => {
      media.addEventListener(eventName, event => {
        console.debug(`stopImmediate ${eventName} capture=false`)
        event.stopImmediatePropagation()
        event.stopPropagation()
      })

      media.addEventListener(
        eventName,
        event => {
          console.debug(`stopImmediate ${eventName} capture=true`)
          event.stopImmediatePropagation()
          event.stopPropagation()
        },
        true
      )
    })

    // TODO: Use MutationObserver to observe if video gets removed from DOM

    const onDurationChange = debounce(signalReady, 2000)
    media.addEventListener('durationchange', onDurationChange, false)
    signalReady()
  }

  const addMedia = media => {
    if (mediaList.has(media)) {
      return
    }

    console.debug('Add media', media, media.src, media.duration)
    mediaList.add(media)

    // Immediately mute to prevent being really loud
    media.volume = 0

    const eventLogger = e => console.debug(`Event: ${e.type}`, e)

    // if (process.env.NODE_ENV === 'development' && !media.__debug__) {
    if (!media.__debug__) {
      const events = [
        'loadeddata',
        'loadedmetadata',
        'loadstart',
        'canplay',
        'canplaythrough',
        'playing',
        'play',
        'pause',
        'durationchange',
        'ratechange',
        'seeking',
        'seeked',
        'suspend',
        'emptied',
        'waiting',
        'error'
      ]
      events.forEach(eventName => {
        media.addEventListener(eventName, eventLogger, false)
      })
      media.__debug__ = true
    }

    // Checks for media when it starts playing
    function checkMediaReady() {
      if (isNaN(media.duration)) {
        return false
      }

      // Wait for videos to appear in the DOM
      if (media instanceof HTMLVideoElement && !media.parentElement) {
        return false
      }

      if (media.readyState >= MediaReadyState.HAVE_CURRENT_DATA) {
        setActiveMedia(media)
        media.removeEventListener('playing', checkMediaReady)
        media.removeEventListener('durationchange', checkMediaReady)
        media.removeEventListener('canplay', checkMediaReady)
        return true
      }

      return false
    }

    if (media.paused || !checkMediaReady()) {
      media.addEventListener('playing', checkMediaReady)
      media.addEventListener('durationchange', checkMediaReady)
      media.addEventListener('canplay', checkMediaReady)

      clearTimeout(autoplayTimerId)
      autoplayTimerId = setTimeout(attemptAutoplay, AUTOPLAY_TIMEOUT)
    }
  }

  /** Interval time (ms) to detect video element. */
  const DETECT_INTERVAL = 500

  /** Threshold before we'll seek. */
  const SEEK_THRESHOLD = 100

  const OldAudio = window.Audio

  /** Proxy `new Audio` to trap audio elements created in-memory. */
  var ProxyAudio = new Proxy(function() {}, {
    construct: function(target, argumentsList, newTarget) {
      console.debug('Audio constructor called: ' + argumentsList.join(', '))
      return new OldAudio(...argumentsList)
    }
  })
  window.Audio = ProxyAudio

  const origCreateElement = document.createElement
  const capturedTags = new Set(['audio', 'video'])

  /** Proxy document.createElement to trap media elements created in-memory. */
  const proxyCreateElement = function(tagName) {
    const element = origCreateElement.call(document, tagName)
    const name = tagName.toLowerCase()

    if (capturedTags.has(name)) {
      console.debug(`[MediaRemote] Created ${tagName} element`)
      console.trace()
      window.TEST = element

      // Wait for attributes to be set
      setTimeout(addMedia, 0, element)
    }

    return element
  }

  maskNative(proxyCreateElement)
  document.createElement = proxyCreateElement

  /** Abstraction around HTML video tag. */
  class HTMLMediaPlayer {
    constructor(media) {
      this.media = media

      this.onPlay = this.onPlay.bind(this)
      this.onVolumeChange = this.onVolumeChange.bind(this)
      this.onWaiting = this.onWaiting.bind(this)

      this.media.addEventListener('play', this.onPlay, false)
      this.media.addEventListener('volumechange', this.onVolumeChange, false)
    }

    dispatch(eventName, detail) {
      const e = new CustomEvent(eventName, { detail: detail, cancelable: true, bubbles: false })
      document.dispatchEvent(e)
      return e.defaultPrevented
    }

    play() {
      if (this.dispatch('ms:play')) return
      this.startWaitingListener()
      return this.media.play()
    }
    pause() {
      if (this.dispatch('ms:pause')) return
      this.stopWaitingListener()
      this.media.pause()
    }
    getCurrentTime() {
      return this.media.currentTime
    }
    getDuration() {
      return this.media.duration
    }
    seek(time) {
      if (this.dispatch('ms:seek', time)) return

      // Infinity is generally used for a dynamically allocated media object
      // or live media
      const duration = this.getDuration() * SEC2MS
      if (duration === Infinity || !isValidDuration(duration)) {
        return
      }

      // Only seek if we're off by greater than our threshold
      if (this.timeExceedsThreshold(time)) {
        this.media.currentTime = time / 1000
      }
    }
    setVolume(volume) {
      // MUST SET THIS FIRST
      this.volume = volume

      this.media.volume = volume

      if (this.media.muted && volume > 0) {
        this.media.muted = false
      }
    }

    /** Only seek if we're off by greater than our threshold */
    timeExceedsThreshold(time) {
      const dt = Math.abs(time / 1000 - this.getCurrentTime()) * 1000
      return dt > SEEK_THRESHOLD
    }

    /** Set volume as soon as playback begins */
    onPlay() {
      if (typeof this.volume === 'number') {
        this.setVolume(this.volume)
      }
    }

    /** Prevent third-party service from restoring cached volume */
    onVolumeChange() {
      const { volume } = this
      if (volume && this.media.volume !== volume) {
        console.debug(`Volume changed internally (${this.media.volume}), reverting to ${volume}`)
        this.setVolume(volume)
      }
    }

    startWaitingListener() {
      if (this._awaitingStart) return
      this.media.addEventListener('waiting', this.onWaiting, false)
    }

    stopWaitingListener() {
      this.media.removeEventListener('waiting', this.onWaiting, false)
      if (this._endWaiting) this._endWaiting()
    }

    /** Force start playback on waiting */
    onWaiting() {
      if (this._awaitingStart) return
      this._awaitingStart = true

      let timeoutId = null

      const onStarted = () => {
        this.media.removeEventListener('playing', onStarted, false)
        clearTimeout(timeoutId)

        if (this.media.paused) {
          this.media.play().catch(noop)

          // HACK: Clear buffering spinner
          setTimeout(() => {
            if (!this.media.paused) {
              this.media.pause()
              this.media.play().catch(noop)
            }
          }, 1000)
        }

        this._awaitingStart = false
        this._endWaiting = null
      }
      this._endWaiting = onStarted
      this.media.addEventListener('playing', onStarted, false)

      let startTime = this.media.currentTime
      let time = startTime
      let attempt = 1

      const ATTEMPT_INTERVAL = 200
      const tryPlayback = () => {
        console.debug(
          `Attempting to force start playback [#${attempt++}][networkState=${
            this.media.networkState
          }][readyState=${this.media.readyState}]`
        )
        time += ATTEMPT_INTERVAL / 1000

        const dt = Math.abs(time - startTime)
        if (dt > 1) {
          startTime = time
          this.seek(time * 1000)
        } else {
          this.dispatch('ms:pause') || this.media.pause()
          const playPromise = this.dispatch('ms:play') || this.media.play()
          if (playPromise && playPromise.then) playPromise.catch(noop)
        }

        if (this.media.readyState === 4) {
          onStarted()
          return
        }

        timeoutId = setTimeout(tryPlayback, ATTEMPT_INTERVAL)
      }

      const initialDelay = this._hasAttemptedStart ? 200 : 1000
      timeoutId = setTimeout(tryPlayback, initialDelay)
      this._hasAttemptedStart = true
    }
  }

  /** Detect media content on page */
  const detectPlayer = () => {
    const mediaElements = document.querySelectorAll('video, audio')

    if (mediaElements.length > 0) {
      Array.from(mediaElements).forEach(media => {
        console.debug(`Found media element!`, media.tagName, media, player)
        addMedia(media)
      })
    } else {
      setTimeout(detectPlayer, DETECT_INTERVAL)
      // console.debug(`Couldn't find media element on page, trying again...`);
    }
  }

  /** Setup IPC message listeners */
  const setupListeners = () => {
    document.addEventListener('CMediaSeek', e => {
      console.log('SEEK EVENT', e)
      const time = e.detail
      console.info(`Received seek command [time=${time}]`)
      if (player) {
        player.seek(time)
      }
    })

    document.addEventListener('CMediaPlaybackChange', e => {
      const state = e.detail
      console.info(`Received playback command [state=${state}]`)
      if (player) {
        switch (state) {
          case PlaybackState.Playing:
            player.play()
            break
          case PlaybackState.Paused:
            player.pause()
            break
        }
      }
    })

    document.addEventListener('CMediaVolumeChange', e => {
      const volume = e.detail
      console.info(`Received volume command [volume=${volume}] (${location.hostname})`)
      if (player) {
        player.setVolume(volume)
      }
    })

    document.addEventListener('mouseup', e => {
      if (e.movementX === 1234) {
        e.stopImmediatePropagation()
        e.preventDefault()
        console.log(`Fullscreen mouseup event`, e, location.href)
        fullscreenMedia()
      }
    })
  }

  setupListeners()

  const pageLoad = new Promise(resolve => {
    window.onload = resolve
  })

  const loadTimeout = new Promise(resolve => {
    setTimeout(resolve, 100)
  })

  await Promise.race([pageLoad, loadTimeout])
  detectPlayer()
})()
