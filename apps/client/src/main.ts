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

const link = new ForgeLink();
link.onStatus = (on) => hud.setLink(on);
const forgeControls = new Controls(document.querySelector('#controls')!, (cmd) => link.send(cmd), crew.names);
const offeringCards = new OfferingCards(document.querySelector('#offerings')!, (cmd) => link.send(cmd), crew.names);
const alerts = new Alerts(document.querySelector('.hud-meta')!, (cmd) => link.send(cmd));
const dispatch = (e: ForgeEvent): void => {
  crew.handle(e);
  vault.handle(e);
  questBanner.handle(e);
  forgeControls.handle(e);
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

const clock = new THREE.Timer();
let hudTimer = 0;
renderer.setAnimationLoop(() => {
  clock.update();
  const dt = Math.min(clock.getDelta(), 0.05);
  const t = clock.getElapsed();
  controls.update(dt);
  hall.update(t, dt);
  crew.update(t, dt);
  vault.update(t, dt);
  fx.update(t, dt);
  bubbles.update(t);
  audio.update(camera);
  pipeline.render();
  governor.tick(dt);
  if ((hudTimer += dt) > 0.5) {
    hudTimer = 0;
    hud.setFps(governor.fps, governor.dpr);
  }
});
