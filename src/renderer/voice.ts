// Voice chat: a WebRTC audio call between the two players' apps, live while
// both windows are open. Signalling goes through the hub; on a home LAN the
// host candidates connect directly, so no STUN/TURN (works offline).
import { connection } from "./net/connection";
import { get, myId, opponent, set } from "./state/store";

type Signal = { description?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit | null; hello?: boolean };

class Voice {
  private pc: RTCPeerConnection | null = null;
  private peerId: string | null = null;
  private mic: MediaStream | null = null;
  private micPromise: Promise<MediaStream | null> | null = null;
  private audioEl: HTMLAudioElement | null = null;
  private makingOffer = false;
  private ignoreOffer = false;
  private meter: { ctx: AudioContext; timer: ReturnType<typeof setInterval> } | null = null;

  /** Re-evaluates whether a call should be running; call on any relevant change. */
  update(): void {
    const s = get();
    const opp = opponent(s);
    const want = s.conn === "connected" && s.windowVisible && !!opp?.online && opp.windowOpen;
    if (!want || !opp) {
      this.hangUp();
      set({ voice: s.conn === "connected" && s.windowVisible ? "waiting" : "off" });
      return;
    }
    if (this.pc && this.peerId === opp.id) return;
    this.hangUp();
    void this.call(opp.id);
  }

  setMuted(muted: boolean): void {
    for (const t of this.mic?.getAudioTracks() ?? []) t.enabled = !muted;
  }

  private async getMic(): Promise<MediaStream | null> {
    if (this.mic) return this.mic;
    this.micPromise ??= navigator.mediaDevices
      .getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
      .then((m) => (this.mic = m))
      .catch(() => null)
      .finally(() => (this.micPromise = null));
    return this.micPromise;
  }

  private async call(peerId: string): Promise<void> {
    set({ voice: "connecting" });
    this.peerId = peerId;
    const pc = new RTCPeerConnection({ iceServers: [] });
    this.pc = pc;
    const mic = await this.getMic();
    if (this.pc !== pc) return;
    if (!mic) {
      set({ voice: "no-mic" });
    } else {
      this.setMuted(get().prefs.micMuted);
      for (const track of mic.getAudioTracks()) pc.addTrack(track, mic);
    }
    // Make sure we can receive even without a microphone.
    if (!mic) pc.addTransceiver("audio", { direction: "recvonly" });

    pc.onicecandidate = ({ candidate }) => this.send({ candidate: candidate?.toJSON() ?? null });
    pc.onnegotiationneeded = async () => {
      try {
        this.makingOffer = true;
        await pc.setLocalDescription();
        this.send({ description: pc.localDescription!.toJSON() });
      } catch {
        // Negotiation will be retried on the next change.
      } finally {
        this.makingOffer = false;
      }
    };
    pc.ontrack = ({ streams }) => {
      if (!this.audioEl) {
        this.audioEl = new Audio();
        this.audioEl.autoplay = true;
      }
      this.audioEl.srcObject = streams[0] ?? null;
      void this.audioEl.play().catch(() => {});
      this.startMeter(streams[0]);
    };
    pc.onconnectionstatechange = () => {
      if (this.pc !== pc) return;
      if (pc.connectionState === "connected") set({ voice: get().voice === "no-mic" ? "no-mic" : "connected" });
      if (pc.connectionState === "failed") {
        this.hangUp();
        setTimeout(() => this.update(), 1000);
      }
    };
    // Tell the peer we're ready, so it (re)starts negotiation if it was waiting.
    this.send({ hello: true });
  }

  private send(data: Signal): void {
    if (this.peerId) connection.send({ type: "rtc", to: this.peerId, data });
  }

  /** Perfect negotiation (https://w3c.github.io/webrtc-pc/#perfect-negotiation-example). */
  async signal(from: string, raw: unknown): Promise<void> {
    const data = raw as Signal;
    if (!this.pc || from !== this.peerId) {
      if (data.hello) this.update();
      return;
    }
    const pc = this.pc;
    const polite = myId() > from;
    try {
      if (data.hello) {
        // The peer has a fresh connection. A connected one of ours is stale.
        if (pc.connectionState === "connected") {
          this.hangUp();
          return void this.call(from);
        }
        // Anything we sent before it existed was lost: the impolite side
        // (re)sends its offer, the polite side drops its own and waits.
        if (polite) {
          if (pc.signalingState === "have-local-offer") await pc.setLocalDescription({ type: "rollback" });
        } else if (pc.signalingState === "have-local-offer") {
          this.send({ description: pc.localDescription!.toJSON() });
        } else if (pc.signalingState === "stable" && !this.makingOffer) {
          this.makingOffer = true;
          await pc.setLocalDescription();
          this.send({ description: pc.localDescription!.toJSON() });
          this.makingOffer = false;
        }
        return;
      }
      if (data.description) {
        const collision = data.description.type === "offer" && (this.makingOffer || pc.signalingState !== "stable");
        this.ignoreOffer = !polite && collision;
        if (this.ignoreOffer) return;
        await pc.setRemoteDescription(data.description);
        if (data.description.type === "offer") {
          await pc.setLocalDescription();
          this.send({ description: pc.localDescription!.toJSON() });
        }
      } else if (data.candidate !== undefined) {
        try {
          await pc.addIceCandidate(data.candidate ?? undefined);
        } catch (e) {
          if (!this.ignoreOffer) throw e;
        }
      }
    } catch {
      this.makingOffer = false;
    }
  }

  private startMeter(stream: MediaStream | undefined): void {
    this.stopMeter();
    if (!stream) return;
    try {
      const ctx = new AudioContext();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      ctx.createMediaStreamSource(stream).connect(analyser);
      const buf = new Uint8Array(analyser.fftSize);
      const timer = setInterval(() => {
        analyser.getByteTimeDomainData(buf);
        let peak = 0;
        for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
        const talking = peak > 12;
        if (talking !== get().remoteTalking) set({ remoteTalking: talking });
      }, 150);
      this.meter = { ctx, timer };
    } catch {
      // Level meter is cosmetic.
    }
  }

  private stopMeter(): void {
    if (!this.meter) return;
    clearInterval(this.meter.timer);
    void this.meter.ctx.close();
    this.meter = null;
    set({ remoteTalking: false });
  }

  private hangUp(): void {
    this.stopMeter();
    if (this.pc) {
      this.pc.onicecandidate = null;
      this.pc.ontrack = null;
      this.pc.onnegotiationneeded = null;
      this.pc.onconnectionstatechange = null;
      this.pc.close();
    }
    this.pc = null;
    this.peerId = null;
    if (this.audioEl) this.audioEl.srcObject = null;
    // Release the microphone so the OS indicator turns off.
    for (const t of this.mic?.getTracks() ?? []) t.stop();
    this.mic = null;
  }

  /** Connection to the hub dropped. */
  reset(): void {
    this.hangUp();
    set({ voice: "off" });
  }
}

export const voice = new Voice();
