import * as THREE from 'three/webgpu';
import { pass } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CREW, type ForgeEvent } from '@deepanvil/shared';
import { Soundscape } from './audio.ts';
import { Bubbles } from './bubbles.ts';
import { coinsOf } from './coins.ts';
import { Controls } from './controls.ts';
import { Hud } from './hud.ts';
import { BlueprintCard } from './blueprint.ts';
import { ChangeCard } from './change.ts';
import { ClarifyForm } from './clarify.ts';
import { DwarfCard } from './dwarfcard.ts';
import { HistoryPanel } from './history.ts';
import { Slates } from './slates.ts';
import { OfferingCards } from './offerings.ts';
import { Alerts } from './push.ts';
import { QuestBanner } from './quest.ts';
import { ForgeLink } from './net.ts';
import { FrameGovernor, initialQuality, isTouchDevice } from './quality.ts';
import { Crew, loadCrewKit } from './world/crew.ts';
import { Fx, loadCoin } from './world/fx.ts';
import { loadHall } from './world/hall.ts';
import { loadOdinKit, Vault } from './world/vault.ts';
import { kuwahara } from './world/painterly.ts';

const quality = initialQuality();
const canvas = document.querySelector<HTMLCanvasElement>('#world')!;
const hud = new Hud(document.querySelector('#hud')!);

const renderer = new THREE.WebGPURenderer({ canvas, antialias: quality.tier !== 'low' });
renderer.toneMapping = THREE.AgXToneMapping;
renderer.toneMappingExposure = 0.95;
renderer.shadowMap.enabled = quality.shadows;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
await renderer.init();

const backend = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend ? 'WebGPU' : 'WebGL2';
hud.setBackend(backend, quality.tier);

const scene = new THREE.Scene();
scene.background = new THREE.Color('#2a1d14');
scene.fog = new THREE.Fog('#2e2018', 34, 80);

const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 200);
const portrait = window.innerWidth < window.innerHeight;
// Portrait phones start higher and further back so the whole hall fits the tall frame.
if (portrait) camera.position.set(3, 13, 13);
else camera.position.set(3, 8, 14);

const controls = new OrbitControls(camera, canvas);
if (portrait) controls.target.set(-1, 0.5, -5.5);
else controls.target.set(0, 2.2, -4);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 7;
controls.maxDistance = 34;
controls.maxPolarAngle = Math.PI * 0.46;
controls.minPolarAngle = Math.PI * 0.12;
controls.enablePan = false;
controls.autoRotate = true;
controls.autoRotateSpeed = 0.25;
controls.addEventListener('start', () => (controls.autoRotate = false));

const [hall, crewKit, odinKit, coinGeo] = await Promise.all([loadHall(quality), loadCrewKit(), loadOdinKit(), loadCoin()]);
scene.add(hall.group);

const fx = new Fx(coinGeo);
scene.add(fx.group);

const bubbles = new Bubbles(document.querySelector('#bubbles')!, camera);
const audio = new Soundscape();
const furnaceFire = hall.anchors.get('fire');
if (furnaceFire) audio.furnace.copy(furnaceFire.position);

// Sound needs a user gesture. Desktop starts it on the first click; phones stay muted
// until the speaker toggle is tapped (cozy soundscape, muted by default on the phone).
hud.onSoundToggle = (on) => (on ? audio.enable() : audio.disable());
if (!isTouchDevice) {
  const autostart = (ev: PointerEvent): void => {
    // The speaker button handles its own clicks; don't toggle twice.
    if ((ev.target as Element | null)?.closest('[data-sound]')) return;
    removeEventListener('pointerdown', autostart);
    if (!audio.enabled && hud.soundWanted !== false) {
      audio.enable();
      hud.setSound(true);
    }
  };
  addEventListener('pointerdown', autostart);
}

const crew = new Crew(fx, hall, crewKit, bubbles, audio);
const questBanner = new QuestBanner(document.querySelector('#quest')!, crew.names);
crew.setRoster(CREW); // show the crew immediately; the server's roster replaces it on connect
scene.add(crew.group);
const vault = new Vault(hall, odinKit, bubbles, audio, fx);
vault.locate = (id) => crew.headOf(id);
crew.onOffer = (offeringId) => vault.receive(offeringId);
scene.add(vault.group);

if (import.meta.env.DEV) Object.assign(window, { THREE, scene, camera, controls, crew, fx, hall, vault });

// Bloom over the HDR scene: only emissives, sparks and the sky opening are bright enough to bleed.
const pipeline = new THREE.RenderPipeline(renderer);
const scenePass = pass(scene, camera);
const sceneColor = scenePass.getTextureNode('output');
const glowNode = bloom(sceneColor, quality.bloomStrength, 0.35, 1.1);
// Desktop gets soft brushstrokes over the whole frame; bloom is added after so glows stay smooth.
const painted = quality.brushstrokes && !new URLSearchParams(location.search).has('nobrush') ? kuwahara(sceneColor, 2) : sceneColor;
pipeline.outputNode = painted.add(glowNode);

const governor = new FrameGovernor(quality.maxDpr, (dpr) => {
  renderer.setPixelRatio(dpr);
  resize();
});
renderer.setPixelRatio(governor.dpr);

function resize(): void {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  // Portrait phones: pull the camera back so the whole hall fits.
  camera.fov = w < h ? 58 : 42;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

// Tap a dwarf (or Odin): open their card. A tap is a press and release that barely moved,
// so orbiting and pinching never open one. The nearest one within reach of the finger wins.
const slates = new Slates(document.querySelector('#slates')!, camera, (id) => crew.slatePoint(id));
const dwarfCard = new DwarfCard(document.querySelector('#card')!);
let followId: string | undefined;
const follow = new THREE.Vector3();
dwarfCard.onFollow = (id) => {
  followId = id;
  if (id) controls.autoRotate = false;
};
controls.addEventListener('start', () => {
  if (followId) {
    followId = undefined;
    dwarfCard.released();
  }
});
{
  let down: { x: number; y: number; t: number } | undefined;
  const v = new THREE.Vector3();
  canvas.addEventListener('pointerdown', (ev) => (down = { x: ev.clientX, y: ev.clientY, t: performance.now() }));
  canvas.addEventListener('pointerup', (ev) => {
    if (!down || Math.hypot(ev.clientX - down.x, ev.clientY - down.y) > 8 || performance.now() - down.t > 450) return;
    const rect = canvas.getBoundingClientRect();
    const reach = isTouchDevice ? 48 : 34; // px
    let best: { id: string; d: number } | undefined;
    for (const t of [...crew.targets(), vault.target()].filter((x): x is { id: string; point: THREE.Vector3 } => !!x)) {
      v.copy(t.point).project(camera);
      if (v.z > 1) continue;
      const d = Math.hypot((v.x * 0.5 + 0.5) * rect.width + rect.left - ev.clientX, (-v.y * 0.5 + 0.5) * rect.height + rect.top - ev.clientY);
      if (d < reach && (!best || d < best.d)) best = { id: t.id, d };
    }
    dwarfCard.open(best?.id);
  });
}

const link = new ForgeLink();
link.onStatus = (on) => hud.setLink(on);
const forgeControls = new Controls(document.querySelector('#controls')!, (cmd) => link.send(cmd), crew.names);
const historyPanel = new HistoryPanel(document.querySelector('#history')!, (cmd) => link.send(cmd), crew.names);
hud.onHistory = () => historyPanel.toggle();
const changeCard = new ChangeCard(document.querySelector('#change')!, (cmd) => link.send(cmd));
const blueprintCard = new BlueprintCard(document.querySelector('#blueprint')!, (cmd) => link.send(cmd));
const clarify = new ClarifyForm(document.querySelector('#clarify')!, (cmd) => link.send(cmd));
const offeringCards = new OfferingCards(document.querySelector('#offerings')!, (cmd) => link.send(cmd), crew.names);
const alerts = new Alerts(document.querySelector('.hud-meta')!, (cmd) => link.send(cmd));
const dispatch = (e: ForgeEvent): void => {
  crew.handle(e);
  vault.handle(e);
  dwarfCard.handle(e);
  slates.handle(e);
  questBanner.handle(e);
  forgeControls.handle(e);
  clarify.handle(e);
  blueprintCard.handle(e);
  changeCard.handle(e);
  historyPanel.handle(e);
  offeringCards.handle(e);
  alerts.handle(e);
  hud.gauge(e);
  hud.log(e, crew.names);
};
link.on(dispatch);
// Dev only: replay hand-written events through the world (no server, no tokens).
if (import.meta.env.DEV) Object.assign(window, { forgeDispatch: dispatch });
setInterval(() => hud.renderGauges(), 30_000); // keep reset countdowns fresh

// The in-world treasury: the gold pile is what's left of the week, the furnace burns as
// hot as the crew is spending (coins per minute over the last two minutes).
const spendLog: { at: number; coins: number }[] = [];
link.on((e) => {
  if (e.type === 'limits' && e.sevenDay) hall.setTreasury(1 - e.sevenDay.utilization);
  if (e.type === 'usage.tick') spendLog.push({ at: performance.now(), coins: coinsOf(e.costUsd) });
});
setInterval(() => {
  const now = performance.now();
  while (spendLog.length && now - spendLog[0]!.at > 120_000) spendLog.shift();
  const perMinute = spendLog.reduce((sum, s) => sum + s.coins, 0) / 2;
  hall.setHeat(perMinute / 8); // ~8 coins a minute is a roaring forge
}, 1000);
link.connect();

// Calm mode: with no events and no input for a while the hall idles at 30 fps (battery, fans).
// Any event that isn't just a gauge refresh, or any touch/key/wheel, brings back full rate.
const CALM_AFTER = 25_000;
const CALM_FRAME = 1 / 30 - 0.002;
const QUIET = new Set<ForgeEvent['type']>(['hello', 'limits', 'ledger', 'forge.status', 'history', 'vault.health', 'push.config']);
let lastActive = performance.now();
const wake = (): void => {
  lastActive = performance.now();
};
for (const type of ['pointerdown', 'pointermove', 'wheel', 'keydown', 'touchstart']) addEventListener(type, wake, { passive: true });
link.on((e) => {
  if (!QUIET.has(e.type)) wake();
});
const clock = new THREE.Timer();
let hudTimer = 0;
let owed = 0; // time since the last frame we actually drew (calm mode skips frames)
renderer.setAnimationLoop(() => {
  clock.update();
  const calm = performance.now() - lastActive > CALM_AFTER && !followId;
  owed += clock.getDelta();
  if (calm && owed < CALM_FRAME) return;
  const dt = Math.min(owed, 0.05);
  owed = 0;
  const t = clock.getElapsed();
  if (followId) {
    // Glide the orbit centre onto the followed dwarf, carrying the camera with it.
    const t0 = [...crew.targets(), vault.target()].find((x) => x?.id === followId);
    if (t0) {
      follow.copy(t0.point).setY(1.2).sub(controls.target).multiplyScalar(1 - Math.exp(-4 * dt));
      controls.target.add(follow);
      camera.position.add(follow);
    }
  }
  controls.update(dt);
  hall.update(t, dt);
  crew.update(t, dt);
  vault.update(t, dt);
  fx.update(t, dt);
  bubbles.update(t);
  slates.update(t);
  audio.update(camera);
  pipeline.render();
  if (!calm) governor.tick(dt); // 30 fps by choice must not read as a struggling GPU
  if ((hudTimer += dt) > 0.5) {
    hudTimer = 0;
    hud.setFps(calm ? 30 : governor.fps, governor.dpr, calm);
  }
});
