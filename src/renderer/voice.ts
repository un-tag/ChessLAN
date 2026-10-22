// Voice chat: a WebRTC audio call between the two players' apps, live while
// both windows are open. Signalling goes through the hub; on a home LAN the
// host candidates connect directly, so no STUN/TURN (works offline).
//
// Handshake: every peer connection has a random session id (sid). Each side
// announces its session with `hello`. The player with the smaller id always
// makes the offer, addressed to the answerer's session, so there are no
// offer collisions. Messages for an old session (from before a reload or
// reconnect) are dropped, and a hello from a new peer session restarts the
// call cleanly.
import type { MicState } from "../shared/protocol";
import { connection } from "./net/connection";
import { get, myId, opponent, set } from "./state/store";

interface Signal {
  sid: string; // sender's session
  rsid: string | null; // the session it is addressed to
  hello?: true;
  description?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit | null;
}

const randomSid = (): string => Math.random().toString(36).slice(2) + Date.now().toString(36);

/** Why the microphone can't be used, from getUserMedia's error. */
function micProblem(e: unknown): MicState {
  const name = (e as { name?: unknown } | null)?.name;
  if (name === "NotAllowedError" || name === "SecurityError") return "blocked";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "missing";
  return "failed"; // e.g. NotReadableError: in use, or the OS refused to start it
}

const setMic = (mic: MicState | null): void => {
  if (get().mic !== mic) set({ mic });
};

class Voice {
  private pc: RTCPeerConnection | null = null;
  private peerId: string | null = null;
  private sid = "";
  private remoteSid: string | null = null;
  private generation = 0;
  private starting = false;
  private queuedCandidates: RTCIceCandidateInit[] = [];
  private mic: MediaStream | null = null;
  private audioEl: HTMLAudioElement | null = null;
  private meter: { ctx: AudioContext; timer: ReturnType<typeof setInterval> } | null = null;

  /** Re-evaluates whether a call should be running; call on any relevant change. */
  update(): void {
    const s = get();
    const opp = opponent(s);
    const want = s.conn === "connected" && s.windowVisible && !!opp?.online && opp.windowOpen;
    if (!want || !opp) {
      this.hangUp();
      this.releaseMic();
      set({ voice: s.conn === "connected" && s.windowVisible ? "waiting" : "off" });
      return;
    }
    if (this.peerId === opp.id && (this.pc || this.starting)) return;
    void this.start(opp.id, { announce: true });
  }

  setMuted(muted: boolean): void {
    for (const t of this.mic?.getAudioTracks() ?? []) t.enabled = !muted;
    if (this.mic) setMic(muted ? "muted" : "on");
  }

  private get isOfferer(): boolean {
    return myId() < (this.peerId ?? "");
  }

  private async getMic(): Promise<MediaStream | null> {
    if (this.mic?.active) return this.mic;
    try {
      const mic = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      this.mic = mic;
      // Unplugged, or taken away by the OS mid-call.
      for (const t of mic.getAudioTracks()) t.onended = () => this.mic === mic && setMic("failed");
      this.setMuted(get().prefs.micMuted);
    } catch (e) {
      this.mic = null;
      setMic(micProblem(e));
    }
    return this.mic;
  }

  private releaseMic(): void {
    // Stopping the tracks turns the OS microphone indicator off.
    for (const t of this.mic?.getTracks() ?? []) {
      t.onended = null;
      t.stop();
    }
    this.mic = null;
    setMic(null);
  }

  /** Fresh peer connection. `offerTo`: offer straight away to that answerer session. */
  private async start(peerId: string, opts: { announce: boolean; offerTo?: string }): Promise<void> {
    this.hangUp();
    const gen = ++this.generation;
    this.peerId = peerId;
    this.starting = true;
    set({ voice: "connecting" });
    const mic = await this.getMic();
    if (gen !== this.generation) return; // superseded while waiting for the mic
    this.starting = false;

    const pc = new RTCPeerConnection({ iceServers: [] });
    this.pc = pc;
    this.sid = randomSid();
    this.remoteSid = opts.offerTo ?? null;
    this.queuedCandidates = [];
    if (mic) {
      for (const track of mic.getAudioTracks()) pc.addTrack(track, mic);
    } else {
      pc.addTransceiver("audio", { direction: "recvonly" });
    }
    pc.onicecandidate = ({ candidate }) => this.send({ candidate: candidate?.toJSON() ?? null });
    pc.ontrack = ({ streams }) => this.playRemote(streams[0]);
    pc.onconnectionstatechange = () => {
      if (this.pc !== pc) return;
      if (pc.connectionState === "connected") set({ voice: mic ? "connected" : "no-mic" });
      if (pc.connectionState === "failed") {
        // Both sides notice; each restarts and the hellos re-pair them.
        setTimeout(() => this.pc === pc && void this.start(peerId, { announce: true }), 1000);
      }
    };
    if (opts.offerTo) await this.offer();
    if (opts.announce) this.send({ hello: true });
  }

  private send(data: Omit<Signal, "sid" | "rsid">): void {
    if (!this.peerId) return;
    const msg: Signal = { ...data, sid: this.sid, rsid: this.remoteSid };
    connection.send({ type: "rtc", to: this.peerId, data: msg });
  }

  private async offer(): Promise<void> {
    const pc = this.pc;
    if (!pc) return;
    await pc.setLocalDescription(await pc.createOffer());
    if (this.pc === pc) this.send({ description: pc.localDescription!.toJSON() });
  }

  async signal(from: string, raw: unknown): Promise<void> {
    const d = raw as Signal;
    if (!d || typeof d.sid !== "string") return;
    if (from !== this.peerId || !this.pc) {
      // Not in a call with them (yet): their hello may be what we were waiting for.
      if (d.hello) this.update();
      return;
    }
    const pc = this.pc;
    try {
      if (d.hello) {
        if (this.isOfferer) {
          if (this.remoteSid === null) {
            this.remoteSid = d.sid;
            await this.offer();
          } else if (this.remoteSid !== d.sid) {
            // The answerer has a new session: start over and offer to it.
            await this.start(from, { announce: false, offerTo: d.sid });
          }
        } else if (this.remoteSid && this.remoteSid !== d.sid && pc.remoteDescription) {
          // The offerer restarted but we're still tied to its old session.
          await this.start(from, { announce: true });
        } else {
          // Let the offerer know where to send its offer.
          this.send({ hello: true });
        }
        return;
      }
      if (d.rsid !== this.sid) return; // addressed to an old session of ours
      if (d.description?.type === "offer" && !this.isOfferer) {
        if (pc.remoteDescription && d.sid !== this.remoteSid) return void this.start(from, { announce: true });
        this.remoteSid = d.sid;
        await pc.setRemoteDescription(d.description);
        await pc.setLocalDescription(await pc.createAnswer());
        this.send({ description: pc.localDescription!.toJSON() });
        await this.flushCandidates();
      } else if (d.description?.type === "answer" && this.isOfferer) {
        if (d.sid !== this.remoteSid || pc.signalingState !== "have-local-offer") return;
        await pc.setRemoteDescription(d.description);
        await this.flushCandidates();
      } else if (d.candidate !== undefined && d.sid === this.remoteSid) {
        if (!d.candidate) return;
        if (pc.remoteDescription) await pc.addIceCandidate(d.candidate);
        else this.queuedCandidates.push(d.candidate);
      }
    } catch (e) {
      console.warn("voice signalling failed", e);
    }
  }

  private async flushCandidates(): Promise<void> {
    const list = this.queuedCandidates;
    this.queuedCandidates = [];
    for (const c of list) await this.pc?.addIceCandidate(c).catch(() => {});
  }

  private playRemote(stream: MediaStream | undefined): void {
    if (!this.audioEl) {
      this.audioEl = new Audio();
      this.audioEl.autoplay = true;
    }
    this.audioEl.srcObject = stream ?? null;
    void this.audioEl.play().catch(() => {});
    this.startMeter(stream);
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
      // The talking indicator is cosmetic.
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
    this.generation++;
    this.starting = false;
    this.stopMeter();
    if (this.pc) {
      this.pc.onicecandidate = null;
      this.pc.ontrack = null;
      this.pc.onconnectionstatechange = null;
      this.pc.close();
    }
    this.pc = null;
    this.peerId = null;
    this.remoteSid = null;
    if (this.audioEl) this.audioEl.srcObject = null;
  }

  /** The hub connection dropped. */
  reset(): void {
    this.hangUp();
    this.releaseMic();
    set({ voice: "off" });
  }
}

export const voice = new Voice();
