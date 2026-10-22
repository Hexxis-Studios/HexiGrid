import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { VRMLoaderPlugin } from '@pixiv/three-vrm';

const EMOTION_PRESETS = Object.freeze(['neutral', 'happy', 'angry', 'sad', 'relaxed', 'surprised']);
const DEG = Math.PI / 180;

class HexiVrmViewer extends HTMLElement {
  static get observedAttributes() { return ['src', 'orientation', 'scale', 'animation-name', 'autoplay', 'expression']; }

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.shadowRoot.innerHTML = '<link rel="stylesheet" href="/vendor/vrm-viewer.css"><canvas aria-label="Interactive 3D VRM avatar"></canvas><p class="error" role="status" aria-live="polite" hidden></p>';
    this.canvas = this.shadowRoot.querySelector('canvas');
    this.canvas.setAttribute('aria-label', this.getAttribute('alt') || 'Interactive 3D VRM avatar');
    this.errorBox = this.shadowRoot.querySelector('.error');
    this.renderer = null;
    this.scene = null;
    this.camera = null;
    this.controls = null;
    this.vrm = null;
    this.mixer = null;
    this.gltf = null;
    this.frame = 0;
    this.lastFrame = 0;
    this._loaded = false;
    this._paused = true;
    this._loadId = 0;
    this._visible = true;
    this._onVisibility = () => this._syncFrameLoop();
    this._observer = typeof IntersectionObserver === 'function' ? new IntersectionObserver(entries => {
      this._visible = entries.some(entry => entry.isIntersecting);
      this._syncFrameLoop();
    }) : null;
  }

  connectedCallback() {
    this._observer?.observe(this);
    document.addEventListener('visibilitychange', this._onVisibility);
    this._load();
  }

  disconnectedCallback() {
    this._observer?.unobserve(this);
    document.removeEventListener('visibilitychange', this._onVisibility);
    this._stopFrameLoop();
    this._disposeModel();
    this.controls?.dispose(); this.controls = null;
    this.resizeObserver?.disconnect(); this.resizeObserver = null;
    this.renderer?.dispose(); this.renderer = null;
    this.scene = null; this.camera = null;
  }

  attributeChangedCallback(name, oldValue, newValue) {
    if (oldValue === newValue || !this.isConnected) return;
    if (name === 'src') { this._load(); return; }
    if (name === 'animation-name') this._selectAnimation();
    if (name === 'expression') this._selectExpression();
    if (name === 'orientation' || name === 'scale') this._applyTransform();
    if (name === 'autoplay' && this._loaded) this.play();
  }

  get loaded() { return this._loaded; }
  get paused() { return this._paused; }
  get availableAnimations() { return this.gltf?.animations?.map(clip => clip.name || '') || []; }
  get availableExpressions() {
    const manager = this.vrm?.expressionManager;
    return manager ? EMOTION_PRESETS.filter(name => manager.getExpression(name)) : [];
  }

  play() {
    this._paused = false;
    this._selectAnimation();
    this._syncFrameLoop();
  }

  pause() {
    this._paused = true;
  }

  _ensureScene() {
    if (this.renderer) return;
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, alpha: true, antialias: true, powerPreference: 'low-power' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.scene = new THREE.Scene();
    this.scene.background = null;
    this.camera = new THREE.PerspectiveCamera(30, 1, 0.01, 1000);
    this.camera.position.set(0, 1.1, 3.8);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x61586d, 2.0));
    const key = new THREE.DirectionalLight(0xffffff, 2.1); key.position.set(2, 4, 3); this.scene.add(key);
    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = true;
    this.controls.target.set(0, 1, 0);
    this.controls.minDistance = 0.4;
    this.controls.maxDistance = 18;
    this.controls.maxPolarAngle = Math.PI * 0.88;
    this.controls.addEventListener('change', () => this._render());
    this.resizeObserver = new ResizeObserver(() => this._resize());
    this.resizeObserver.observe(this);
    this.canvas.addEventListener('webglcontextlost', event => { event.preventDefault(); this._fail(new Error('Graphics context was interrupted. Hide and show the avatar to reload it.')); });
  }

  _resize() {
    if (!this.renderer || !this.camera) return;
    const rect = this.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this._render();
  }

  async _load() {
    const src = this.getAttribute('src');
    if (!src || !this.isConnected) return;
    const loadId = ++this._loadId;
    this._loaded = false;
    this.errorBox.hidden = true;
    try {
      this._ensureScene();
      this._disposeModel();
      const loader = new GLTFLoader();
      loader.register(parser => new VRMLoaderPlugin(parser));
      const gltf = await loader.loadAsync(src);
      if (loadId !== this._loadId || !this.isConnected) { disposeGltf(gltf); return; }
      const vrm = gltf.userData?.vrm;
      if (!vrm?.scene) { disposeGltf(gltf); throw new Error('The file did not contain a supported VRM model. Choose a self-contained VRM 1.0 or VRM 0.x avatar.'); }
      this.gltf = gltf;
      this.vrm = vrm;
      this.scene.add(vrm.scene);
      vrm.scene.rotation.y = Math.PI;
      this._applyTransform();
      this.mixer = new THREE.AnimationMixer(vrm.scene);
      this._fitCamera(vrm.scene);
      this._loaded = true;
      this._paused = !this.hasAttribute('autoplay');
      this._selectExpression();
      this._selectAnimation();
      this.dataset.loadState = 'ready';
      this.dispatchEvent(new Event('load'));
      this._resize();
      this._syncFrameLoop();
    } catch (error) {
      if (loadId === this._loadId) this._fail(error);
    }
  }

  _fitCamera(root) {
    root.updateWorldMatrix(true, true);
    const bounds = new THREE.Box3().setFromObject(root);
    if (bounds.isEmpty()) return;
    const center = bounds.getCenter(new THREE.Vector3());
    const size = bounds.getSize(new THREE.Vector3());
    const height = Math.max(size.y, size.x, size.z, 0.5);
    this.controls.target.copy(center);
    this.camera.position.set(center.x, center.y + height * 0.12, center.z + height * 2.65);
    this.controls.minDistance = height * 0.35;
    this.controls.maxDistance = height * 8;
    this.controls.update();
  }

  _applyTransform() {
    const root = this.vrm?.scene;
    if (!root) return;
    const rotation = String(this.getAttribute('orientation') || '').trim().split(/\s+/);
    const yaw = Number.parseFloat(rotation.at(-1)) || 0;
    const scales = String(this.getAttribute('scale') || '1 1 1').trim().split(/\s+/).map(Number);
    const scale = Number.isFinite(scales[0]) ? THREE.MathUtils.clamp(scales[0], 0.1, 4) : 1;
    root.rotation.y = Math.PI + THREE.MathUtils.clamp(yaw, -180, 180) * DEG;
    root.scale.setScalar(scale);
    this._render();
  }

  _selectAnimation() {
    if (!this.mixer || !this.gltf) return;
    this.mixer.stopAllAction();
    const requested = this.getAttribute('animation-name') || '';
    const clip = this.gltf.animations.find(item => item.name === requested) || (!requested && this.hasAttribute('autoplay') ? this.gltf.animations[0] : null);
    if (clip && !this._paused) this.mixer.clipAction(clip).play();
  }

  _selectExpression() {
    const manager = this.vrm?.expressionManager;
    if (!manager) return;
    const selected = this.getAttribute('expression') || 'neutral';
    manager.resetValues();
    if (this.availableExpressions.includes(selected)) manager.setValue(selected, 1);
    manager.update();
    this._render();
  }

  _syncFrameLoop() {
    if (!this.renderer || !this.isConnected || !this._visible || document.hidden) { this._stopFrameLoop(); return; }
    if (!this.frame) { this.lastFrame = 0; this.frame = requestAnimationFrame(time => this._tick(time)); }
  }

  _stopFrameLoop() {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
  }

  _tick(time) {
    this.frame = 0;
    const delta = this.lastFrame ? Math.min((time - this.lastFrame) / 1000, 0.05) : 0;
    this.lastFrame = time;
    if (!this._paused) this.mixer?.update(delta);
    this.vrm?.update(delta);
    this.controls?.update();
    this._render();
    this._syncFrameLoop();
  }

  _render() {
    if (!this.renderer || !this.scene || !this.camera) return;
    try { this.renderer.render(this.scene, this.camera); }
    catch (error) { this._fail(error); }
  }

  _fail(error) {
    this._loaded = false;
    this._paused = true;
    this.dataset.loadState = 'failed';
    this._stopFrameLoop();
    this.errorBox.textContent = userMessage(error);
    this.errorBox.hidden = false;
    this.dispatchEvent(new Event('error'));
  }

  _disposeModel() {
    if (this.vrm?.scene) this.scene?.remove(this.vrm.scene);
    this.mixer?.stopAllAction();
    this.mixer?.uncacheRoot(this.vrm?.scene);
    disposeGltf(this.gltf);
    this.gltf = null; this.vrm = null; this.mixer = null;
  }
}

function userMessage(error) {
  const message = String(error?.message || '');
  if (/responded with\s+\d{3}/i.test(message)) return 'The avatar file could not be reached. Check the saved local file and reload the avatar.';
  if (error?.name === 'SyntaxError' || /unexpected .*json|json.*(invalid|parse)/i.test(message)) return 'The avatar file is malformed or incomplete. Choose a valid self-contained VRM file.';
  if (/webgl|graphics context/i.test(message)) return '3D graphics were interrupted. Hide and show the avatar to reload it.';
  return message.replace(/https?:\/\/[^\s"']+/g, '[avatar URL]').slice(0, 240) || 'The VRM avatar could not be loaded. Choose another self-contained model and try again.';
}

function disposeGltf(gltf) {
  if (!gltf?.scene) return;
  gltf.scene.traverse(node => {
    node.geometry?.dispose?.();
    for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
      if (!material) continue;
      for (const value of Object.values(material)) if (value?.isTexture) value.dispose();
      material.dispose?.();
    }
  });
}

if (!customElements.get('hexi-vrm-viewer')) customElements.define('hexi-vrm-viewer', HexiVrmViewer);
