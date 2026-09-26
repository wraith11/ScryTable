import { getWallPoints, getWallPoly, calculateVisibility } from './utils.js';

// Lineare Interpolation für smoothe Bewegung
function lerp(start, end, amt) {
    return (1 - amt) * start + amt * end;
}

function startAngleFromOffset(offset) {
    return -Math.PI/2 + offset;
}

export class GameRenderer {
    constructor(sceneData, isGM) {
        this.scene = sceneData;
        this.isGM = isGM;
        
        this.pixiApp = null;
        this.world = null;
        this.containers = {};
        this.entityCache = {};
        this.textureCache = {};
        this.tokenCache = {};
        this.drawingCache = {};

        // --- FoW Internals ---
        this.fowScreenTexture = null; 
        this.fowMemoryTexture = null; 
        
        this.depthRenderTexture = null;
        this.depthSprite = null;
        this.depthGraphics = new PIXI.Graphics(); 

        this.darknessTexture = null; 
        this.currentDarkness = 0.0;
        
        this.lightMaskContainer = new PIXI.Container();
        this.lightTintContainer = new PIXI.Container();
        this.flickerMaskContainer = new PIXI.Container();
        this.flickerTintContainer = new PIXI.Container();
        
        this.depthLayer = new PIXI.Container();
        // Statischer Blur für Konsistenz beim Zoomen
        this.wallDepthBlur = new PIXI.BlurFilter(4, 3); 
        this.depthLayer.filters = [this.wallDepthBlur];
        this.depthLayer.alpha = 0.35; 

        this.nightSprite = null;
        this.darknessBg = new PIXI.Graphics();
        
        // Statischer Blur für Konsistenz beim Zoomen
        this.shadowFilter = new PIXI.BlurFilter(8, 3);

        this.mapDirty = true; 
        this.lightsDirty = true;
        this.flickerDirty = false;
        this.drawingsDirty = true; 
        this.mapRebuilt = false;
        this.fowDirty = true; 
        this.fowBlurDirty = false;
        this.fowBlurredTexture = null;
        this._fowSettleTimer = null;
        this._lastFoWRenderTime = 0;
        this._lastFoWViewHash = "";
        this._cachedSegments = null;
        this._segmentsVersion = 0;
        
        this._lastScale = -1;
        this._lastViewX = -99999;
        this._lastViewY = -99999;
        this._renderDirty = true; 
        this.lastFlickerUpdate = 0;
        this.lastFoWPathLength = 0;
        
        this._cacheState = { grid: '', overlay: '', pFrame: '' };

        this.toolSettings = { wallWidth: 15, brushSize: 15 }; 
        this.drawColor = '#ffffff';
        this.brushTexture = null;
        this.tilesPerAxis = 2;
        this.dragState = { mode: null, temp: null };
        this.selectedObjId = null;
        this.lastDragHash = "";
        
        // --- PERFORMANCE: Event Driven Rendering ---
        this.renderBound = this.render.bind(this);
        this._renderPending = false;
        this._lightLoopRunning = false;
    }

    init() {
        this.pixiApp = new PIXI.Application({ 
            resizeTo: window, 
            backgroundColor: 0x000000, 
            antialias: true,
            autoDensity: true,
            resolution: 1, 
            autoStart: false // Disable autoStart for event-driven rendering
        });
        document.getElementById('pixi-container').appendChild(this.pixiApp.view);
        
        // Ensure no ticker is running
        this.pixiApp.ticker.stop();
        this.pixiApp.ticker.destroy();

        this.world = new PIXI.Container(); 
        this.world.sortableChildren = true;
        this.pixiApp.stage.addChild(this.world);
        
        this.pixiApp.stage.addChild(this.depthLayer);
        this.pixiApp.stage.eventMode = 'static'; 
        this.pixiApp.stage.hitArea = this.pixiApp.screen;
        
        this.depthRenderTexture = PIXI.RenderTexture.create({ width: this.pixiApp.screen.width, height: this.pixiApp.screen.height });
        this.depthSprite = new PIXI.Sprite(this.depthRenderTexture);
        this.depthLayer.addChild(this.depthSprite);

        this.containers = {
            bgImage: new PIXI.Container(), 
            bg: new PIXI.Container(),      
            grid: new PIXI.Graphics(),     
            draw: new PIXI.Container(),    
            preview: new PIXI.Graphics(),  
            mapLow: new PIXI.Container(),   
            shadows: new PIXI.Container(),  
            mapOutline: new PIXI.Graphics(),
            structure: new PIXI.Container(), 
            objectsHigh: new PIXI.Container(), 
            tokens: new PIXI.Container(), 
            nightLayer: new PIXI.Container(), 
            lights: new PIXI.Container(),     
            fow: new PIXI.Container(),        
            overlay: new PIXI.Graphics(),     
            pFrame: new PIXI.Graphics(),      
            debug: new PIXI.Graphics()        
        };
        
        let z = 0;
        this.containers.bgImage.zIndex = ++z;
        this.containers.bg.zIndex = ++z;       
        this.containers.draw.zIndex = ++z;     
        this.containers.preview.zIndex = ++z;  
        // mapLow (Objekte unter Ebene 0) gehören zum Hintergrund → unter das Grid
        this.containers.mapLow.zIndex = ++z; 
        this.containers.grid.zIndex = ++z;
        this.containers.shadows.zIndex = ++z;
        this.containers.mapOutline.zIndex = ++z; 
        this.containers.structure.zIndex = ++z; 
        this.containers.objectsHigh.zIndex = ++z;
        this.containers.lights.zIndex = ++z;     
        this.containers.fow.zIndex = 1000;      
        this.containers.tokens.zIndex = 1100;
        this.containers.overlay.zIndex = 1200; 
        this.containers.pFrame.zIndex = 1300; 
        this.containers.debug.zIndex = 1400;
        
        Object.values(this.containers).forEach(c => { if(c.eventMode !== 'static') c.eventMode = 'none'; });

        this.containers.mapLow.sortableChildren = true;
        this.containers.structure.sortableChildren = true;
        this.containers.objectsHigh.sortableChildren = true;

        Object.entries(this.containers).forEach(([key, c]) => {
            if (key !== 'nightLayer') this.world.addChild(c);
        });
        
        this.pixiApp.stage.addChild(this.containers.nightLayer);
        // Tint-Container gehören in die Welt UNTER dem FoW (zIndex 900 < 1000),
        // damit der Nebel die Licht-Farbtönung verdeckt.
        this.lightTintContainer.zIndex = 900;
        this.flickerTintContainer.zIndex = 900;
        this.world.addChild(this.lightTintContainer);
        this.world.addChild(this.flickerTintContainer);

        this.containers.shadows.filters = [this.shadowFilter];
        this.containers.shadows.alpha = 0.5;
        
        this.requestRender();
    }

    requestRender() {
        if (this._renderPending) return;
        this._renderPending = true;
        requestAnimationFrame(this.renderBound);
    }

    startLightLoop() {
        if (this._lightLoopRunning) return;
        this._lightLoopRunning = true;
        
        const loop = () => {
            // Check if we need to animate (flicker active or darkness transition incomplete)
            const animating = this.animateLights();
            if (animating) {
                this.requestRender();
                requestAnimationFrame(loop);
            } else {
                this._lightLoopRunning = false;
            }
        };
        loop();
    }

    rebuildFoW() {
        this.fowDirty = true;
        this.updateFoWMemory(true);
    }

    getWorldPos(e) {
        const rect = this.pixiApp.view.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;
        return {
            x: (mouseX - this.world.x) / this.world.scale.x,
            y: (mouseY - this.world.y) / this.world.scale.y
        };
    }

    getSegments() {
        if (!this._cachedSegments || (this.scene.walls && this.scene.walls.length > 0 && this._cachedSegments.length === 0)) {
             const segments = [];
             (this.scene.walls||[]).forEach(wa => {
                if(wa.invisible) return; 
                const isArr = Array.isArray(wa);
                const a = {x:isArr?wa[0]:wa.x1, y:isArr?wa[1]:wa.y1};
                const b = {x:isArr?wa[2]:wa.x2, y:isArr?wa[3]:wa.y2};
                if(wa.curve) {
                    const pts = getWallPoints(a, b, wa.curve);
                    for(let i=0; i<pts.length-1; i++) segments.push({a:pts[i], b:pts[i+1]});
                } else segments.push({a,b});
            });
            (this.scene.columns||[]).forEach(c => {
                const count = (c.vertices && c.vertices > 0) ? c.vertices : 16;
                const rot = (c.rotation || 0) * (Math.PI/180);
                const pts = []; const r = c.radius * 0.9;
                for(let i=0; i<count; i++) { const a = (i/count)*Math.PI*2 + rot; pts.push({x: c.x + Math.cos(a)*r, y: c.y + Math.sin(a)*r}); }
                for(let i=0; i<count; i++) { segments.push({a: pts[i], b: pts[(i+1)%count]}); }
            });
            this._cachedSegments = segments;
        }
        return this._cachedSegments;
    }

    setToolSettings(settings, color, texture, tiles) {
        let changed = false;
        if (this.drawColor !== color) changed = true;
        if (this.brushTexture !== texture) changed = true;
        if (this.tilesPerAxis !== tiles) changed = true;
        if (this.toolSettings.brushSize !== settings.brushSize) changed = true;
        if (changed) {
            this.toolSettings = settings;
            this.drawColor = color;
            this.brushTexture = texture;
            this.tilesPerAxis = tiles;
            if (this.dragState.active) this._renderDirty = true;
        }
    }

    setDragState(drag, selId) {
        if (drag.active) {
            this._renderDirty = true;
        } else {
             const newHash = `${drag.mode}_${selId}`;
             if (this.lastDragHash !== newHash) {
                 this._renderDirty = true;
                 this.lastDragHash = newHash;
             }
        }
        this.dragState = drag;
        this.selectedObjId = selId;
    }
    
    setBlobs(blobs) { this.activeBlobs = blobs; }

    // Setzt die FoW-Memory-Textur zurück (wird beim nächsten Einbrennen neu aufgebaut)
    resetFoWMemory() {
        if (this.fowMemoryTexture) { this.fowMemoryTexture.destroy(true); this.fowMemoryTexture = null; }
        if (this.fowBlurredTexture) { this.fowBlurredTexture.destroy(true); this.fowBlurredTexture = null; }
        this.lastFoWPathLength = 0;
        this.fowBlurDirty = false;
        this.fowWorldX = this.fowWorldY = this.fowWorldW = this.fowWorldH = 0;
    }

    updateFoWMemory(forceRebuild = false) {
        if (!this.scene.fow_active || this.scene.fow_mode !== 'permanent') return;
        
        const visited = this.scene.fow_visited || [];

        // --- FESTES Welt-Feld: wird automatisch erweitert, wenn neue Punkte außerhalb liegen.
        // Start: Player-View + 400px Rand, fest in der Welt verankert (nicht an die View gebunden).
        const pv = this.scene.player_view;
        const gs = this.scene.grid_size;
        const vw = Math.max(1, pv.width_cells * gs);
        const vh = Math.max(1, vw / pv.aspect);

        if (!this.fowMemoryTexture) {
            // Feld-Rand = volle Default-Vision (400), damit eine Figur am Rand der
            // Player-View ihre komplette Sichtweite innerhalb des Felds aufdeckt.
            this.fowWorldX = pv.x - vw/2 - 400;
            this.fowWorldY = pv.y - vh/2 - 400;
            this.fowWorldW = vw + 800;
            this.fowWorldH = vh + 800;
            this.fowMemoryScale = 1.0;
            this.fowMemoryTexture = PIXI.RenderTexture.create({ 
                width: Math.max(1, Math.ceil(this.fowWorldW * this.fowMemoryScale)), 
                height: Math.max(1, Math.ceil(this.fowWorldH * this.fowMemoryScale)),
                scaleMode: PIXI.SCALE_MODES.LINEAR
            });
            if (this.fowBlurredTexture) { this.fowBlurredTexture.destroy(true); this.fowBlurredTexture = null; }
            this.lastFoWPathLength = 0; 
            this.fowBlurDirty = true;
            forceRebuild = true;
        }

        // Safety: visited wurde zurückgesetzt
        if (visited.length < this.lastFoWPathLength) { forceRebuild = true; this.lastFoWPathLength = 0; }
        if (visited.length === this.lastFoWPathLength && !forceRebuild) return;

        // --- Automatische Erweiterung des Welt-Felds, falls neue Punkte außerhalb liegen.
        if (!forceRebuild) {
            let needsGrow = false;
            let minX = this.fowWorldX, minY = this.fowWorldY, maxX = this.fowWorldX+this.fowWorldW, maxY = this.fowWorldY+this.fowWorldH;
            for (let i = this.lastFoWPathLength; i < visited.length; i++) {
                const p = visited[i]; const r = (p.radius||400);
                if (p.x - r < minX) { minX = p.x - r; needsGrow = true; }
                if (p.x + r > maxX) { maxX = p.x + r; needsGrow = true; }
                if (p.y - r < minY) { minY = p.y - r; needsGrow = true; }
                if (p.y + r > maxY) { maxY = p.y + r; needsGrow = true; }
            }
            if (needsGrow) {
                // Alten Inhalt in eine größere Textur verschieben (neuer Welt-Ursprung)
                const oldTex = this.fowMemoryTexture;
                const oldX = this.fowWorldX, oldY = this.fowWorldY;
                const nw = Math.max(this.fowWorldW, (maxX - minX) + 800);
                const nh = Math.max(this.fowWorldH, (maxY - minY) + 800);
                const newTex = PIXI.RenderTexture.create({ width: Math.max(1, Math.ceil(nw * this.fowMemoryScale)), height: Math.max(1, Math.ceil(nh * this.fowMemoryScale)), scaleMode: PIXI.SCALE_MODES.LINEAR });
                // Alten Inhalt an neue Position kopieren
                const oldSprite = new PIXI.Sprite(oldTex);
                oldSprite.position.set((oldX - minX) * this.fowMemoryScale, (oldY - minY) * this.fowMemoryScale);
                this.pixiApp.renderer.render(oldSprite, { renderTexture: newTex, clear: true, transform: null });
                oldSprite.destroy({children:true});
                oldTex.destroy(true);
                this.fowMemoryTexture = newTex;
                this.fowWorldX = minX; this.fowWorldY = minY; this.fowWorldW = nw; this.fowWorldH = nh;
                if (this.fowBlurredTexture) { this.fowBlurredTexture.destroy(true); this.fowBlurredTexture = null; }
                this.fowBlurDirty = true;
                // Nach dem Wachsen alles neu einbrennen (nur den Inhalt, die alten Punkte)
                forceRebuild = true;
            }
        }

        // THROTTLE: Bündeln auf ~150ms
        const now = performance.now();
        if (!forceRebuild && (now - (this._lastFoWBakeTime || 0)) < 150) return;

        const segments = this.getSegments();
        const brush = new PIXI.Graphics();
        brush.beginFill(0xFFFFFF, 1.0); 

        const startIdx = forceRebuild ? 0 : this.lastFoWPathLength;
        const viewX = this.fowWorldX;
        const viewY = this.fowWorldY;
        const ms = this.fowMemoryScale || 1.0;

        for (let i = startIdx; i < visited.length; i++) {
            const pt = visited[i];
            const relX = (pt.x - viewX) * ms;
            const relY = (pt.y - viewY) * ms;
            if (relX < -pt.radius * ms || relX > this.fowWorldW * ms + pt.radius * ms || relY < -pt.radius * ms || relY > this.fowWorldH * ms + pt.radius * ms) continue;

            const poly = calculateVisibility({x: pt.x, y: pt.y, radius: pt.radius}, segments);
            if (poly.length > 0) {
                brush.moveTo((poly[0].x - viewX) * ms, (poly[0].y - viewY) * ms);
                for (let j=1; j<poly.length; j++) brush.lineTo((poly[j].x - viewX) * ms, (poly[j].y - viewY) * ms);
                brush.closePath();
            } else {
                brush.drawCircle(relX, relY, pt.radius * ms);
            }
        }
        brush.endFill();
        this.pixiApp.renderer.render(brush, { renderTexture: this.fowMemoryTexture, clear: forceRebuild, transform: null });
        brush.destroy();

        this.lastFoWPathLength = visited.length;
        this._lastFoWBakeTime = now;
        this.fowBlurDirty = true;
    }

    // Wendet den weichen Rand der Memory-Sicht an. Läuft nach jedem Bake (fowBlurDirty),
    // damit der FoW-Rand dauerhaft weich ist – unabhängig davon, ob sich Token bewegen.
    ensureFoWBlur() {
        if (!this.fowBlurDirty) return;
        this.fowBlurDirty = false;
        if (!this.fowMemoryTexture) return;
        const w = this.fowMemoryTexture.width;
        const h = this.fowMemoryTexture.height;
        if (!this.fowBlurredTexture || this.fowBlurredTexture.width !== w || this.fowBlurredTexture.height !== h) {
            if (this.fowBlurredTexture) this.fowBlurredTexture.destroy(true);
            this.fowBlurredTexture = PIXI.RenderTexture.create({width: w, height: h});
        }
        if (!this.fowBlurFilter) this.fowBlurFilter = new PIXI.BlurFilter(24);
        const src = new PIXI.Sprite(this.fowMemoryTexture);
        src.filters = [this.fowBlurFilter];
        this.pixiApp.renderer.render(src, {renderTexture: this.fowBlurredTexture, clear: true, transform: null});
        src.destroy({children: true});
    }

    renderFoW() {
        if (!this.scene.fow_active) {
            // FoW ausgeschaltet → alle FoW-Sprites entfernen, damit die Map aufgedeckt ist
            while (this.containers.fow.children.length > 0) {
                this.containers.fow.removeChildAt(0).destroy({ children: true });
            }
            return;
        }

        // PERFORMANCE: FoW-Rendering drosseln (~15fps), damit das Tracking im Main-Thread
        // nicht ausgebremst wird. Wichtige Änderungen (fowDirty, View-Wechsel) rendern sofort.
        const now = performance.now();
        const viewHashNow = `${Math.round(this.world.x)}_${Math.round(this.world.y)}_${Math.round(this.world.scale.x*100)}`;
        const viewChangedNow = viewHashNow !== this._lastFoWViewHash;
        if (viewChangedNow) this._lastFoWViewHash = viewHashNow;
        if (!this.fowDirty && !viewChangedNow && (now - (this._lastFoWRenderTime || 0)) < 66) {
            return;
        }
        this._lastFoWRenderTime = now;

        // Zerstöre vorherige FoW-Sprites erst NACH der Drosselung, damit das letzte
        // FoW-Bild zwischen zwei Renders stehen bleibt (kein Flackern).
        while (this.containers.fow.children.length > 0) {
            this.containers.fow.removeChildAt(0).destroy({ children: true });
        }

        const segments = this.getSegments();
        // false = inkrementell einbrennen (nur neue Punkte), statt bei jeder Bewegung alles neu zu baken
        this.updateFoWMemory(false);
        this.fowDirty = false;

        const screenW = this.pixiApp.screen.width;
        const screenH = this.pixiApp.screen.height;

        if (!this.fowScreenTexture || this.fowScreenTexture.width !== screenW || this.fowScreenTexture.height !== screenH) {
             if(this.fowScreenTexture) this.fowScreenTexture.destroy(true);
             this.fowScreenTexture = PIXI.RenderTexture.create({ width: screenW, height: screenH });
        }

        const opacity = this.isGM ? 0.6 : 1.0;
        const blackRect = new PIXI.Graphics();
        blackRect.beginFill(0x000000, opacity);
        blackRect.drawRect(0, 0, screenW, screenH);
        blackRect.endFill();
        this.pixiApp.renderer.render(blackRect, { renderTexture: this.fowScreenTexture, clear: true });
        blackRect.destroy();

        const visionContainer = new PIXI.Container();
        visionContainer.position.set(this.world.x, this.world.y);
        visionContainer.scale.set(this.world.scale.x, this.world.scale.y);
        visionContainer.rotation = this.world.rotation;

        // Permanent Memory Layer (fest in der Welt verankert, nicht an die Player-View gebunden)
        if (this.scene.fow_mode === 'permanent' && this.fowMemoryTexture) {
             this.ensureFoWBlur();
             const tex = this.fowBlurredTexture || this.fowMemoryTexture;
             const permSprite = new PIXI.Sprite(tex);
             permSprite.position.set(this.fowWorldX, this.fowWorldY);
             const invScale = 1 / (this.fowMemoryScale || 1.0);
             permSprite.scale.set(invScale, invScale);
             permSprite.blendMode = PIXI.BLEND_MODES.DST_OUT; 
             visionContainer.addChild(permSprite);
        }

        // Live Vision (applies to both Temporary and Permanent modes)
        const segV = this._segmentsVersion;
        Object.values(this.scene.tokens).forEach(t => {
            // Live-Vision nur für Tokens mit sichtbarem Blob (abandoned Token zeigen kein Sichtfeld)
            if (!t.has_vision) return;
            if (!t.blob_id || !this.activeBlobs || !this.activeBlobs[String(t.blob_id)]) return;
            { 
                // D1: Vision-Polygon cachen – nur neu berechnen bei Bewegung, Reichweiten- oder Wandänderung
                const vKey = `${Math.round(t.x)}_${Math.round(t.y)}_${Math.round(t.vision_range)}_${segV}`;
                if (t._visionKey !== vKey) {
                    t._visionPoly = calculateVisibility({x:t.x, y:t.y, radius: t.vision_range}, segments);
                    t._visionKey = vKey;
                }
                const poly = t._visionPoly;
                if(poly.length > 0) {
                    // Create gradient texture (brightness 1.0 = fully clear)
                    const tex = this.createVisionTexture(t.vision_range);
                    const matrix = new PIXI.Matrix();
                    matrix.translate(-tex.width / 2, -tex.height / 2);
                    // No flicker for vision usually, so scale is 1
                    matrix.scale(1, 1);
                    matrix.translate(t.x, t.y);

                    const visionG = new PIXI.Graphics();
                    visionG.beginTextureFill({ texture: tex, matrix: matrix });
                    visionG.drawPolygon(poly); 
                    visionG.endFill();
                    // Cut hole in the fog
                    visionG.blendMode = PIXI.BLEND_MODES.DST_OUT;
                    visionContainer.addChild(visionG);
                }
            }
        });

        this.pixiApp.renderer.render(visionContainer, { renderTexture: this.fowScreenTexture, clear: false });
        visionContainer.destroy({ children: true });

        const finalSprite = new PIXI.Sprite(this.fowScreenTexture);
        const invScale = 1 / this.world.scale.x;
        finalSprite.position.set(-this.world.x * invScale, -this.world.y * invScale);
        finalSprite.scale.set(invScale);
        
        this.containers.fow.addChild(finalSprite);
    }
    
    render() {
        this._renderPending = false;
        if(!this.pixiApp || !this.pixiApp.renderer) return;
        if(this.pixiApp.renderer.gl && this.pixiApp.renderer.gl.isContextLost()) return;
        if(!this.scene) return;
        
        const pv = this.scene.player_view; const gs = this.scene.grid_size;
        
        if(!this.isGM) {
            const scale = window.innerWidth / (pv.width_cells * gs);
            this.world.scale.set(scale);
            this.world.x = -pv.x * scale + window.innerWidth/2;
            this.world.y = -pv.y * scale + window.innerHeight/2;
        } else {
            this.world.position.set(this.scene.view.x, this.scene.view.y);
            this.world.scale.set(this.scene.view.scale);
        }
        this.world.updateTransform();

        const viewChanged = (
            Math.abs(this.world.scale.x - this._lastScale) > 0.001 ||
            Math.abs(this.world.x - this._lastViewX) > 0.01 || 
            Math.abs(this.world.y - this._lastViewY) > 0.01
        );

        if (viewChanged) {
            this._lastScale = this.world.scale.x;
            this._lastViewX = this.world.x; this._lastViewY = this.world.y;
            this._renderDirty = true; 
            
            // Dynamic Blur for Wall Depth to keep it visually consistent
            this.wallDepthBlur.blur = 4 * this.world.scale.x;
        }

        const tokensMoved = this.renderTokens();
        
        // BUGFIX: Token Smoothness
        // If tokens are interpolating (lerping), we MUST keep requesting frames 
        // until they reach their destination.
        if (tokensMoved) {
            this._renderDirty = true;
            this.requestRender();
        }

        if (this.dragState.active) this._renderDirty = true;
        if (this.mapDirty || this.lightsDirty || this.flickerDirty || this.drawingsDirty || this.fowDirty) this._renderDirty = true;

        // Optimization: Return early if nothing to render
        if (!this._renderDirty) {
             return; 
        }

        let bgHex = 0x222222;
        if(this.scene.background_color) bgHex = parseInt(this.scene.background_color.replace('#',''), 16);
        if (this.pixiApp.renderer.background.color !== bgHex) this.pixiApp.renderer.background.color = bgHex;
        
        if (this.depthRenderTexture && (this.depthRenderTexture.width !== this.pixiApp.screen.width || this.depthRenderTexture.height !== this.pixiApp.screen.height)) {
            this.depthRenderTexture.resize(this.pixiApp.screen.width, this.pixiApp.screen.height);
            this.mapDirty = true; 
        }

        if (this.mapDirty) {
            this.rebuildMap();
            this.mapDirty = false;
            this.mapRebuilt = true;
            this.lightsDirty = true; 
            this.fowDirty = true; 
            this._cachedSegments = null; 
            this._segmentsVersion++;
        }

        if (this.depthGraphics) {
             const matrix = this.world.transform.localTransform;
             this.pixiApp.renderer.render(this.depthGraphics, { renderTexture: this.depthRenderTexture, clear: true, transform: matrix });
        }

        this.renderGridAndTools(pv, gs, viewChanged); 
        this.renderLights(viewChanged); 
        this.renderFoW(); 
        this.renderOverlays(viewChanged);

        if (this.drawingsDirty || this.mapRebuilt) { this.renderStaticDrawings(); this.drawingsDirty = false; this.mapRebuilt = false; }
        
        const isDrawing = this.dragState.active && ['brush','grid_paint','rect_paint','circle_paint'].includes(this.dragState.mode);
        if (isDrawing) { this.renderPreviewDrawing(); } 
        else if (this.containers.preview.children.length > 0) {
            this.containers.preview.clear();
        }

        this.pixiApp.renderer.render(this.pixiApp.stage);
        
        // Reset dirty flag only if no user interaction is pending
        if (!tokensMoved && !this.dragState.active && !isDrawing) { this._renderDirty = false; }
    }

    createVisionTexture(radius) {
        const key = `vis_${Math.round(radius)}`;
        if (this.textureCache[key]) return this.textureCache[key];
        const padding = 20; const dim = (radius + padding) * 2; const center = dim / 2;
        const canvas = document.createElement('canvas'); 
        canvas.width = dim; canvas.height = dim;
        const ctx = canvas.getContext('2d');
        const grd = ctx.createRadialGradient(center, center, 0, center, center, radius);
        
        // --- VISION HARDNESS ---
        grd.addColorStop(0, "rgba(255, 255, 255, 1)"); 
        grd.addColorStop(0.8, "rgba(255, 255, 255, 0.9)"); // 0.8 controls hardness (0.0 - 1.0)
        grd.addColorStop(1, "rgba(255, 255, 255, 0)"); 
        
        ctx.fillStyle = grd; ctx.fillRect(0, 0, dim, dim);
        const tex = PIXI.Texture.from(canvas); 
        this.textureCache[key] = tex;
        this.capTextureCache();
        return tex;
    }

    createGradientTexture(radius, brightness) {
        const key = `grad_${Math.round(radius)}_${Math.round(brightness * 100)}`;
        if (this.textureCache[key]) return this.textureCache[key];
        const padding = 20; const dim = (radius + padding) * 2; const center = dim / 2;
        const canvas = document.createElement('canvas'); 
        canvas.width = dim; canvas.height = dim;
        const ctx = canvas.getContext('2d');
        const grd = ctx.createRadialGradient(center, center, 0, center, center, radius);
        grd.addColorStop(0, "rgba(255, 255, 255, 1)"); 
        grd.addColorStop(Math.min(1, brightness), "rgba(255, 255, 255, 0.5)"); 
        grd.addColorStop(1, "rgba(255, 255, 255, 0)"); 
        ctx.fillStyle = grd; ctx.fillRect(0, 0, dim, dim);
        const tex = PIXI.Texture.from(canvas); 
        this.textureCache[key] = tex;
        this.capTextureCache();
        return tex;
    }

    // E: Begrenzt den Texture-Cache, damit er durch viele Radius-/Helligkeits-Kombinationen nicht unbegrenzt wächst.
    capTextureCache() {
        const MAX = 80;
        const keys = Object.keys(this.textureCache);
        if (keys.length <= MAX) return;
        // Älteste Einträge entfernen (einfachste Eviction-Reihenfolge)
        const excess = keys.length - MAX;
        for (let i = 0; i < excess; i++) {
            const k = keys[i];
            const tex = this.textureCache[k];
            if (tex) { try { tex.destroy(true); } catch(e){} }
            delete this.textureCache[k];
        }
    }
    
    animateLights() {
        if (!this.scene.lights_active) return false;
        const now = Date.now();
        if (now - this.lastFlickerUpdate < 50) return this._lightLoopRunning; // Don't stop, just wait
        this.lastFlickerUpdate = now;
        let anyFlicker = false;
        this.scene.lights.forEach(l => {
            if (l.flicker) {
                if (l._flickerOffset === undefined) l._flickerOffset = Math.random() * 10000;
                const time = (Date.now() + l._flickerOffset) / 100;
                const strength = (l.flicker_strength || 50); 
                l.currentFlickerRadius = (Math.sin(time) + Math.random() * 0.5) * (strength / 10);
                anyFlicker = true;
            } else { l.currentFlickerRadius = 0; }
        });
        if (anyFlicker) { this.flickerDirty = true; this._renderDirty = true; }
        
        let targetDarkness = 0;
        if (this.scene.time_of_day === 'night') targetDarkness = 0.70; 
        
        let darknessChanged = false;
        // Float check epsilon 0.005
        if (Math.abs(this.currentDarkness - targetDarkness) > 0.005) {
            this.currentDarkness += (targetDarkness - this.currentDarkness) * 0.05; 
            darknessChanged = true;
        } else { 
            if (this.currentDarkness !== targetDarkness) {
                 this.currentDarkness = targetDarkness;
                 darknessChanged = true;
            }
        }
        
        if (darknessChanged) { this.flickerDirty = true; this._renderDirty = true; }
        
        // Return true if we need to keep animating (flicker active or transition active)
        return anyFlicker || darknessChanged;
    }

    // Entfernt den Hintergrund-Sprite sofort und zuverlässig (für "Neue Karte")
    clearBackground() {
        while (this.containers.bgImage.children.length > 0) {
            this.containers.bgImage.removeChildAt(0).destroy({ children: true, texture: false, baseTexture: false });
        }
        if (this.scene.background_image) this.scene.background_image.url = null;
        this.mapDirty = true;
        this.requestRender();
    }

    rebuildMap() {
        const cleanContainer = (container) => {
            while(container.children.length > 0) {
                const child = container.getChildAt(0);
                if (child !== this.depthSprite) { 
                    container.removeChild(child);
                    child.destroy({ children: true, texture: false, baseTexture: false });
                } else { break; }
            }
        };

        cleanContainer(this.containers.bgImage);
        cleanContainer(this.containers.shadows);
        
        this.containers.mapOutline.clear();
        const usedIds = new Set();

        if(this.scene.background_image && this.scene.background_image.url) {
            const cfg = this.scene.background_image;
            const tex = PIXI.Texture.from(cfg.url);
            let s; 
            // Skala 1:1 (kein 0.1-Faktor mehr) – scale=1.0 entspricht der Originalbildgröße.
            const actualScale = cfg.scale;
            if(cfg.repeat) {
                s = new PIXI.TilingSprite(tex, 100000, 100000); 
                s.tileScale.set(actualScale); s.tilePosition.set(cfg.x, cfg.y); s.position.set(-50000, -50000);
            } else {
                s = new PIXI.Sprite(tex); s.scale.set(actualScale); s.position.set(cfg.x, cfg.y); s.anchor.set(0.5);
            }
            s.alpha = 1.0; 
            this.containers.bgImage.addChild(s);
            if(!tex.valid) tex.once('update', () => this.mapDirty = true);
        }

        const shGraphics = new PIXI.Graphics();
        this.containers.shadows.addChild(shGraphics);
        shGraphics.beginFill(0x000000, 1.0); 
        
        // Optimization: Disable shadows filter if no walls
        let hasWalls = false;

        const wallOverlapMap = {}; 
        const ptKey = (x,y) => `${Math.round(x)},${Math.round(y)}`;
        const activeWalls = (this.scene.walls || []).map((w, i) => ({w, i})).filter(o => !o.w.invisible);

        activeWalls.forEach(({w, i}) => {
            const k1 = ptKey(w.x1, w.y1); const k2 = ptKey(w.x2, w.y2);
            if(!wallOverlapMap[k1]) wallOverlapMap[k1] = [];
            if(!wallOverlapMap[k2]) wallOverlapMap[k2] = [];
            wallOverlapMap[k1].push(i); wallOverlapMap[k2].push(i);
        });

        const isWinner = (wallIdx, intersectionKey) => {
            const indices = wallOverlapMap[intersectionKey];
            if (!indices || indices.length < 2) return false;
            let winnerIdx = -1; let maxZ = -Infinity;
            indices.forEach(idx => {
                const wObj = this.scene.walls[idx];
                const z = wObj.z !== undefined ? wObj.z : 5;
                if (z > maxZ) { maxZ = z; winnerIdx = idx; } 
                else if (z === maxZ) { if (idx > winnerIdx) winnerIdx = idx; }
            });
            return winnerIdx === wallIdx;
        };

        const outline = this.containers.mapOutline;
        const dbg = this.containers.debug; dbg.clear();
        const dG = this.depthGraphics; dG.clear();
        dG.beginFill(0x000000, 1.0); dG.lineStyle(0);
        
        (this.scene.walls || []).forEach(w => {
             if(!w.id || w.invisible) return;
             hasWalls = true;
             const wallWidth = w.width || 15;
             const depthWidth = wallWidth * 0.5;
             let depthPoly = w.curve ? getWallPoly({x:w.x1, y:w.y1}, {x:w.x2, y:w.y2}, depthWidth, w.curve) : getWallPoly({x:w.x1, y:w.y1}, {x:w.x2, y:w.y2}, depthWidth, 0);
             if (depthPoly.length > 0) dG.drawPolygon(depthPoly);
        });

        (this.scene.columns || []).forEach(c => {
            if (c.vertices > 2) {
                 const ptsD = []; const r = c.radius;
                 for(let i=0; i<c.vertices; i++) { const a = (i/c.vertices)*Math.PI*2 + (c.rotation||0)*Math.PI/180; ptsD.push(c.x + Math.cos(a)*r*0.9, c.y + Math.sin(a)*r*0.9); }
                 dG.drawPolygon(ptsD);
            } else { dG.drawCircle(c.x, c.y, c.radius * 0.9); }
        });
        dG.endFill();
        
        this.containers.shadows.visible = hasWalls;

        (this.scene.walls || []).forEach((w, index) => {
            if(!w.id) return;
            let p1 = {x:w.x1, y:w.y1}; let p2 = {x:w.x2, y:w.y2};
            if ((!w.curve || Math.abs(w.curve) < 0.1) && !w.invisible) {
                const dx = p2.x - p1.x; const dy = p2.y - p1.y;
                const len = Math.hypot(dx, dy);
                if (len > 0.1) {
                    const ext = (w.width || 6) / 2;
                    const ux = dx / len; const uy = dy / len;
                    if (isWinner(index, ptKey(w.x1, w.y1))) p1 = { x: p1.x - ux * ext, y: p1.y - uy * ext };
                    if (isWinner(index, ptKey(w.x2, w.y2))) p2 = { x: p2.x + ux * ext, y: p2.y + uy * ext };
                }
            }
            if(!w.invisible) {
                const thickness = w.width || 6; const curve = w.curve || 0;
                shGraphics.lineStyle({ width: thickness + 12, color: 0x000000, alpha: 1.0, join: PIXI.LINE_JOIN.MITER, cap: PIXI.LINE_CAP.BUTT });
                if(curve !== 0) { shGraphics.endFill(); this.drawWallCurve(shGraphics, {x:w.x1, y:w.y1}, {x:w.x2, y:w.y2}, curve); } 
                else { const dx = p2.x - p1.x; const dy = p2.y - p1.y; if(Math.hypot(dx, dy) > 0.1) { shGraphics.moveTo(p1.x, p1.y); shGraphics.lineTo(p2.x, p2.y); } }
                
                usedIds.add(w.id);
                const poly = getWallPoly(p1, p2, thickness, curve);
                if(poly.length >= 6) {
                    outline.lineStyle({width: 2, color: 0x222222, alignment: 0.5, join: PIXI.LINE_JOIN.MITER});
                    outline.beginFill(0x222222); outline.drawPolygon(poly); outline.endFill();
                    let fill = this.entityCache[w.id];
                    if (!fill) { fill = new PIXI.Graphics(); this.entityCache[w.id] = fill; this.containers.structure.addChild(fill); }
                    fill.clear(); fill.visible = true; fill.zIndex = (w.z !== undefined ? w.z : 5); fill.lineStyle(0);
                    const color = w.color ? parseInt(w.color.replace('#',''),16) : 0x000000;
                    if(!w.texture) { fill.beginFill(color); fill.drawPolygon(poly); fill.endFill(); } 
                    else {
                        const tex = PIXI.Texture.from(w.texture);
                        if (tex.valid) {
                            const angle = Math.atan2(p2.y - p1.y, p2.x - p1.x);
                            const gs = this.scene.grid_size; const tpa = w.tilesPerAxis || 1;
                            const scaleX = (gs * tpa) / tex.width; const scaleY = (gs * tpa) / tex.height;
                            const matrix = new PIXI.Matrix(); matrix.scale(scaleX, scaleY); 
                            if(Math.abs(curve)<0.1) matrix.rotate(angle);
                            fill.beginTextureFill({texture: tex, matrix: matrix}); fill.drawPolygon(poly); fill.endFill();
                        } else { tex.once('update', () => this.mapDirty = true); fill.beginFill(color); fill.drawPolygon(poly); fill.endFill(); }
                    }
                }
            } else if(this.isGM) { 
                dbg.lineStyle(2, 0xFF0000, 0.8);
                if(w.curve) this.drawWallCurve(dbg, {x:w.x1, y:w.y1}, {x:w.x2, y:w.y2}, w.curve);
                else { dbg.moveTo(w.x1, w.y1); dbg.lineTo(w.x2, w.y2); }
            }
        });

        (this.scene.objects||[]).forEach(o => {
            usedIds.add(o.id);
            let s = this.entityCache[o.id];
            if(!s || !(s instanceof PIXI.Sprite)) {
                if(s) s.destroy();
                s = o.type==='video' ? new PIXI.Sprite(PIXI.Texture.from(o.src)) : PIXI.Sprite.from(o.src);
                s.anchor.set(0.5); this.entityCache[o.id] = s;
                const z = o.z !== undefined ? o.z : 5;
                const targetContainer = (z < 0) ? this.containers.mapLow : this.containers.objectsHigh;
                targetContainer.addChild(s);
            }
            const z = o.z !== undefined ? o.z : 5;
            const correctContainer = (z < 0) ? this.containers.mapLow : this.containers.objectsHigh;
            if (s.parent !== correctContainer) correctContainer.addChild(s);
            if (s.texture && !s.texture.valid) s.texture.once('update', () => this.mapDirty = true);
            s.position.set(o.x, o.y); s.rotation = (o.rotation||0) * (Math.PI/180);
            if(o.width && o.height) { s.width = o.width; s.height = o.height; }
            s.zIndex = z; s.alpha = 1.0;
        });

        (this.scene.columns || []).forEach(c => {
            usedIds.add(c.id);
            shGraphics.lineStyle(0); shGraphics.beginFill(0x000000, 1.0);
            if(c.vertices > 2) {
                 const pts = []; const r = c.radius + 6; 
                 for(let i=0; i<c.vertices; i++) { const a = (i/c.vertices)*Math.PI*2 + (c.rotation||0)*Math.PI/180; pts.push(c.x + Math.cos(a)*r, c.y + Math.sin(a)*c.radius); }
                 shGraphics.drawPolygon(pts);
            } else { shGraphics.drawCircle(c.x, c.y, c.radius + 6); }
            shGraphics.endFill();

            outline.lineStyle({width: 2, color: 0x222222, alignment: 0.5}); outline.beginFill(0x222222);
            let entity = this.entityCache[c.id];
            if (!entity) { entity = new PIXI.Graphics(); this.entityCache[c.id] = entity; this.containers.structure.addChild(entity); }
            entity.clear(); entity.zIndex = (c.z !== undefined ? c.z : 10); entity.lineStyle(0); 
            const col = c.color ? parseInt(c.color.replace('#',''),16) : 0x444444;
            if(c.texture) {
                 const tex = PIXI.Texture.from(c.texture);
                 if(tex.valid) {
                     const tpa = c.tilesPerAxis || 1;
                     const scaleX = (this.scene.grid_size * tpa) / tex.width; const scaleY = (this.scene.grid_size * tpa) / tex.height;
                     const m = new PIXI.Matrix(); m.scale(scaleX, scaleY); entity.beginTextureFill({texture: tex, matrix: m});
                 } else { tex.once('update', () => this.mapDirty = true); entity.beginFill(col); }
            } else { entity.beginFill(col); }

            if(c.vertices > 2) {
                 const pts = []; const r = c.radius;
                 for(let i=0; i<c.vertices; i++) { const a = (i/c.vertices)*Math.PI*2 + (c.rotation||0)*Math.PI/180; pts.push(c.x + Math.cos(a)*r, c.y + Math.sin(a)*c.radius); }
                 pts.push(pts[0], pts[1]); outline.drawPolygon(pts); entity.drawPolygon(pts);
            } else { outline.drawCircle(c.x, c.y, c.radius); entity.drawCircle(c.x, c.y, c.radius); }
            outline.endFill(); entity.endFill();
        });
        
        Object.keys(this.entityCache).forEach(k => {
            if (!usedIds.has(Number(k)) && !usedIds.has(k)) {
                this.entityCache[k].destroy(); delete this.entityCache[k];
            }
        });
    }

    renderLights(viewChanged) {
        const nl = this.containers.nightLayer; 
        const lc = this.containers.lights; 
        
        if (this.lightsDirty) {
             while (lc.children.length > 0) lc.removeChildAt(0).destroy();
             if(this.isGM && this.scene.show_light_icons) {
                this.scene.lights.forEach(l => {
                    const icon = new PIXI.Graphics();
                    icon.lineStyle(2, 0xffffff); icon.beginFill(0xffff00);
                    icon.drawCircle(0,0,4); icon.endFill(); icon.position.set(l.x, l.y); lc.addChild(icon); 
                });
            }
        }

        if (!this.scene.lights_active) {
            nl.visible = false;
            this.lightTintContainer.visible = false;
            this.flickerTintContainer.visible = false;
            this.lightsDirty = false;
            this.flickerDirty = false;
            return;
        }
        nl.visible = true;
        this.lightTintContainer.visible = true;
        this.flickerTintContainer.visible = true;
        
        if (!this.lightsDirty && !this.flickerDirty && !viewChanged) {
             if (this.nightSprite) this.nightSprite.alpha = this.currentDarkness; 
             return;
        }

        // C1: Darkness nur rendern, wenn tatsächlich sichtbar (Nachts). Tint bleibt immer erhalten.
        const needDarkness = this.currentDarkness > 0.005;

        const segments = this.getSegments();
        const segVersion = this._segmentsVersion;
        const viewBounds = this.getVisibleWorldBounds();

        const setWorld = (c) => {
            c.position.set(this.world.x, this.world.y);
            c.scale.set(this.world.scale.x, this.world.scale.y);
            c.rotation = this.world.rotation;
        };
        // Tint-Container sind jetzt Kinder der Welt und erben deren Transform – keine manuelle Welt-Transform nötig
        setWorld(this.lightMaskContainer);
        setWorld(this.flickerMaskContainer);

        const cleanAndDestroy = (container) => {
             while (container.children.length > 0) {
                const child = container.children[0];
                container.removeChild(child);
                child.destroy();
            }
        };

        const inView = (l, effR) => {
            return !(l.x + effR < viewBounds.x || l.x - effR > viewBounds.x + viewBounds.width ||
                     l.y + effR < viewBounds.y || l.y - effR > viewBounds.y + viewBounds.height);
        };

        // C2: Sicht-Polygon pro Licht cachen (Weltkoordinaten, view-unabhängig).
        // Neu nur, wenn Position/effektiver Radius/Wände sich ändern.
        const getCachedPoly = (l, effR) => {
            const key = `${Math.round(l.x)}_${Math.round(l.y)}_${Math.round(effR)}_${segVersion}`;
            if (l._polyKey !== key) {
                const cullDist = effR + 50;
                const nearby = segments.filter(s => {
                    return !(Math.max(s.a.x, s.b.x) < l.x - cullDist || Math.min(s.a.x, s.b.x) > l.x + cullDist ||
                             Math.max(s.a.y, s.b.y) < l.y - cullDist || Math.min(s.a.y, s.b.y) > l.y + cullDist);
                });
                l._poly = calculateVisibility({x:l.x, y:l.y, radius: effR}, nearby);
                l._polyKey = key;
            }
            return l._poly;
        };

        const buildGraphics = (l, maskContainer, tintContainer) => {
            const flickerOffset = l.currentFlickerRadius || 0;
            const baseRadius = l.radius;
            const effectiveRadius = baseRadius + flickerOffset;
            if (!inView(l, effectiveRadius)) return;
            const poly = getCachedPoly(l, effectiveRadius);
            if (poly.length === 0) return;
            const tex = this.createGradientTexture(baseRadius, l.brightness === undefined ? 0.5 : l.brightness);
            const flickerScale = effectiveRadius / baseRadius;
            const matrix = new PIXI.Matrix();
            matrix.translate(-tex.width / 2, -tex.height / 2);
            matrix.scale(flickerScale, flickerScale);
            matrix.translate(l.x, l.y);

            if (needDarkness && maskContainer) {
                const holeG = new PIXI.Graphics();
                holeG.beginTextureFill({ texture: tex, matrix: matrix });
                holeG.drawPolygon(poly); 
                holeG.endFill();
                holeG.blendMode = PIXI.BLEND_MODES.DST_OUT;
                maskContainer.addChild(holeG);
            }
            if (tintContainer) {
                const colorG = new PIXI.Graphics();
                colorG.beginTextureFill({ texture: tex, matrix: matrix });
                colorG.drawPolygon(poly);
                colorG.endFill();
                colorG.blendMode = PIXI.BLEND_MODES.ADD;
                colorG.tint = l.color ? parseInt(l.color.replace('#', ''), 16) : 0xffaa00;
                colorG.alpha = (l.color_intensity !== undefined) ? l.color_intensity : 0.2;
                tintContainer.addChild(colorG);
            }
        };

        // C3: Flackernde von statischen Lichtern trennen.
        // Statische Lichter werden nur bei lightsDirty (strukturelle Änderung) neu aufgebaut,
        // nicht bei jedem Flacker-Tick.
        const staticLights = this.scene.lights.filter(l => !l.flicker);
        const flickerLights = this.scene.lights.filter(l => !!l.flicker);

        if (this.lightsDirty) {
            cleanAndDestroy(this.lightMaskContainer);
            cleanAndDestroy(this.lightTintContainer);
            staticLights.forEach(l => buildGraphics(l, this.lightMaskContainer, this.lightTintContainer));
            cleanAndDestroy(this.flickerMaskContainer);
            cleanAndDestroy(this.flickerTintContainer);
            flickerLights.forEach(l => buildGraphics(l, this.flickerMaskContainer, this.flickerTintContainer));
        } else if (this.flickerDirty) {
            // Nur Flacker-Layer neu aufbauen
            cleanAndDestroy(this.flickerMaskContainer);
            cleanAndDestroy(this.flickerTintContainer);
            flickerLights.forEach(l => buildGraphics(l, this.flickerMaskContainer, this.flickerTintContainer));
        }

        // Darkness-Texture aufbauen (C1: nur wenn Darkness sichtbar)
        if (needDarkness) {
            if (!this.darknessTexture || this.darknessTexture.width !== this.pixiApp.screen.width || this.darknessTexture.height !== this.pixiApp.screen.height) {
                if(this.darknessTexture) this.darknessTexture.destroy(true);
                this.darknessTexture = PIXI.RenderTexture.create({width: this.pixiApp.screen.width, height: this.pixiApp.screen.height});
                if (this.nightSprite) this.nightSprite.destroy();
                this.nightSprite = new PIXI.Sprite(this.darknessTexture);
                this.nightSprite.blendMode = PIXI.BLEND_MODES.NORMAL;
                nl.addChildAt(this.nightSprite, 0); 
            }

            this.darknessBg.clear();
            this.darknessBg.beginFill(0x050510, 1.0); 
            this.darknessBg.drawRect(0,0, this.pixiApp.screen.width, this.pixiApp.screen.height);
            this.darknessBg.endFill();
            this.pixiApp.renderer.render(this.darknessBg, {renderTexture: this.darknessTexture, clear: true});

            this.pixiApp.renderer.render(this.lightMaskContainer, { renderTexture: this.darknessTexture, clear: false });
            this.pixiApp.renderer.render(this.flickerMaskContainer, { renderTexture: this.darknessTexture, clear: false });
        }

        if (this.nightSprite) this.nightSprite.alpha = this.currentDarkness; 
        this.lightsDirty = false;
        this.flickerDirty = false;
    }

    renderOverlays(viewChanged) {
        if (!this.isGM) { 
            if (this.containers.overlay.children.length > 0) this.containers.overlay.clear(); 
            return; 
        }

        if (!this.dragState.active) {
            // FIX: Hash needs to include z-index for color updates
            const selObj = this.selectedObjId ? 
                (this.scene.objects.find(x => x.id === this.selectedObjId) || this.scene.walls.find(x => x.id === this.selectedObjId) || this.scene.columns.find(x => x.id === this.selectedObjId) || this.scene.lights.find(x => x.id === this.selectedObjId)) 
                : null;
            
            const selZ = selObj ? (selObj.z !== undefined ? selObj.z : 0) : 0;
            const stateHash = `${this.selectedObjId}_${selZ}_idle`;
            
            if (!viewChanged && this._cacheState.overlay === stateHash) return; 
            this._cacheState.overlay = stateHash;
        } else {
             this._cacheState.overlay = ''; 
        }

        const g = this.containers.overlay; g.clear();
        const scale = this.world.scale.x; 
        const handleSize = 5 / scale;

        // VORSCHAU: Säulen
        if (this.dragState.active && this.dragState.mode === 'column' && this.dragState.temp) {
            const t = this.dragState.temp;
            g.lineStyle(2 / scale, 0x00ffff, 0.8);
            if (t.vertices > 2) {
                const pts = []; const r = t.radius;
                for (let i = 0; i < t.vertices; i++) {
                    const a = (i / t.vertices) * Math.PI * 2 + (t.rotation || 0) * Math.PI / 180;
                    pts.push(t.x + Math.cos(a) * r, t.y + Math.sin(a) * r);
                }
                pts.push(pts[0], pts[1]);
                g.drawPolygon(pts);
            } else g.drawCircle(t.x, t.y, t.radius);
        }

        // SELEKTION
        if (this.selectedObjId) {
            let color = 0x0088ff; 
            const selObj = this.scene.walls.find(x => x.id === this.selectedObjId) || 
                         this.scene.columns.find(x => x.id === this.selectedObjId) ||
                         this.scene.objects.find(x => x.id === this.selectedObjId) ||
                         this.scene.lights.find(x => x.id === this.selectedObjId);

            if (selObj && selObj.z !== undefined && selObj.z < 0) color = 0x0000AA; 

            g.lineStyle(2 / scale, color, 1);
            g.beginFill(color, 0.1);

            let found = false;
            if (!found) {
                const w = this.scene.walls.find(x => x.id === this.selectedObjId);
                if (w) {
                    if (w.curve) this.drawWallCurve(g, {x:w.x1, y:w.y1}, {x:w.x2, y:w.y2}, w.curve);
                    else { g.moveTo(w.x1, w.y1); g.lineTo(w.x2, w.y2); }
                    g.beginFill(color); g.drawCircle(w.x1, w.y1, handleSize); g.drawCircle(w.x2, w.y2, handleSize); g.endFill();
                    found = true;
                }
            }
            if (!found) {
                const c = this.scene.columns.find(x => x.id === this.selectedObjId);
                if (c) {
                    g.drawCircle(c.x, c.y, c.radius + 2);
                    const rot = (c.rotation||0) * Math.PI/180;
                    const hDist = c.radius + (30 / scale); 
                    const hx = c.x + Math.sin(rot) * hDist;
                    const hy = c.y - Math.cos(rot) * hDist;
                    g.moveTo(c.x + Math.sin(rot)*c.radius, c.y - Math.cos(rot)*c.radius);
                    g.lineTo(hx, hy);
                    g.beginFill(color); g.drawCircle(hx, hy, handleSize); g.endFill();
                    
                    const resizePt = {x: c.x + Math.sin(rot + Math.PI/4)*c.radius, y: c.y - Math.cos(rot + Math.PI/4)*c.radius};
                    g.beginFill(color); g.drawCircle(resizePt.x, resizePt.y, handleSize); g.endFill();
                    found = true;
                }
            }
            if (!found) {
                const o = this.scene.objects.find(x => x.id === this.selectedObjId) || this.scene.lights.find(x => x.id === this.selectedObjId);
                if (o) {
                    if (o.radius) { 
                         g.drawCircle(o.x, o.y, 20/scale); 
                         g.lineStyle(1/scale, color, 0.5); g.drawCircle(o.x, o.y, o.radius);
                    } else { 
                         const w = o.width; const h = o.height;
                         const rot = (o.rotation||0) * Math.PI/180;
                         const cos = Math.cos(rot); const sin = Math.sin(rot);
                         const t = (lx, ly) => ({ x: o.x + lx*cos - ly*sin, y: o.y + lx*sin + ly*cos });
                         const tl = t(-w/2, -h/2); const tr = t(w/2, -h/2);
                         const br = t(w/2, h/2); const bl = t(-w/2, h/2);
                         g.moveTo(tl.x, tl.y); g.lineTo(tr.x, tr.y); g.lineTo(br.x, br.y); g.lineTo(bl.x, bl.y); g.lineTo(tl.x, tl.y);
                         g.beginFill(color);
                         [tl, tr, br, bl].forEach(p => g.drawRect(p.x-4/scale, p.y-4/scale, 8/scale, 8/scale));
                         g.endFill();

                         // FIX: ADD ROTATION HANDLE FOR OBJECTS
                         const handleDistScreen = 30 / scale;
                         const hTop = {x: 0, y: -h/2 - handleDistScreen};
                         
                         // Rotate handle position
                         const rotH = {
                             x: o.x + hTop.x*cos - hTop.y*sin,
                             y: o.y + hTop.x*sin + hTop.y*cos
                         };
                         // Top edge center
                         const topEdge = {
                             x: o.x + (0)*cos - (-h/2)*sin, 
                             y: o.y + (0)*sin + (-h/2)*cos
                         };
                         
                         g.moveTo(topEdge.x, topEdge.y);
                         g.lineTo(rotH.x, rotH.y);
                         g.beginFill(color); g.drawCircle(rotH.x, rotH.y, handleSize); g.endFill();
                    }
                    found = true;
                }
            }
            g.endFill();
        }

        if (this.dragState.active && this.dragState.temp && this.dragState.mode === 'wall') {
            const t = this.dragState.temp;
            g.lineStyle(2/scale, 0x00ffff, 0.8); 
            g.moveTo(t.x1, t.y1); g.lineTo(t.x2, t.y2);
            g.beginFill(0x00ffff); g.drawCircle(t.x1, t.y1, 3/scale); g.drawCircle(t.x2, t.y2, 3/scale); g.endFill();
        }
    }

    drawSingleDrawingItem(targetGraphics, item, gs) {
        const d = targetGraphics;
        let col = item.color ? parseInt(item.color.replace('#',''),16) : 0xffffff;
        let width = item.size || this.toolSettings.brushSize;
        d.lineStyle(0);
        
        let textureDrawn = false;
        
        if(item.texture) {
            const tex = PIXI.Texture.from(item.texture);
            if(tex.valid && tex.width > 1) {
                const tpa = item.tilesPerAxis || 1;
                const scaleX = (gs * tpa) / tex.width; const scaleY = (gs * tpa) / tex.height;
                let m = new PIXI.Matrix(); m.scale(scaleX, scaleY);
                if(item.type==='path') d.lineStyle({width:width, color: 0xffffff, texture:tex, matrix:m, cap:PIXI.LINE_CAP.ROUND, join:PIXI.LINE_JOIN.ROUND});
                else d.beginTextureFill({texture:tex, matrix:m});
                textureDrawn = true;
            } 
        } 
        
        if (!textureDrawn) {
            if(item.type.includes('paint') || item.type==='circle') d.beginFill(col); 
            else d.lineStyle({width:width, color:col, cap:PIXI.LINE_CAP.ROUND, join:PIXI.LINE_JOIN.ROUND});
        }
        
        if(item.type==='rect' || item.type==='rect_paint') d.drawRect(item.x, item.y, item.w, item.h);
        else if(item.type==='circle' || item.type==='circle_paint') d.drawCircle(item.x, item.y, item.radius);
        else if(item.type==='grid' || item.type==='grid_paint') item.cells.forEach(c => d.drawRect(c.x, c.y, gs, gs));
        else if(item.type==='path') {
            if(item.points.length === 1) { 
                if (!textureDrawn) d.beginFill(item.color ? parseInt(item.color.replace('#',''),16) : 0xffffff); 
                d.drawCircle(item.points[0].x, item.points[0].y, width/2); 
                if (!textureDrawn) d.endFill(); 
            } 
            else { d.moveTo(item.points[0].x, item.points[0].y); item.points.forEach(p => d.lineTo(p.x, p.y)); }
        }
        d.endFill();
        return textureDrawn;
    }

    renderStaticDrawings() {
        const gs = this.scene.grid_size;
        // Container komplett leeren – verhindert, dass gelöschte Hintergrund-Grafiken
        // (Kreise/Rechteck-Pinsel) als "Geister" verdunkelt stehen bleiben.
        while (this.containers.draw.children.length > 0) {
            this.containers.draw.removeChildAt(0).destroy({ children: true, texture: true, baseTexture: false });
        }
        this.drawingCache = {};
        
        if (this.scene.drawings) {
            this.scene.drawings.forEach(item => {
                if (!item.id) return; 
                if (item.texture) {
                    const tex = PIXI.Texture.from(item.texture);
                    if (!tex.valid || tex.width <= 1) {
                        if (!tex._events || !tex._events.update || tex._events.update.length === 0) {
                            tex.once('update', () => { this.drawingsDirty = true; });
                        }
                    }
                }

                const g = new PIXI.Graphics();
                const usedTexture = this.drawSingleDrawingItem(g, item, gs);
                if (item.texture && !usedTexture) g._isPlaceholder = true;
                
                this.containers.draw.addChild(g);
                this.drawingCache[item.id] = g;
            });
        }
    }

    renderPreviewDrawing() {
        const d = this.containers.preview; d.clear();
        if (this.dragState.active && this.dragState.temp) {
            this.drawSingleDrawingItem(d, this.dragState.temp, this.scene.grid_size);
        }
    }
    
    renderGridAndTools(pv, gs, viewChanged) {
        const gridHash = `${this.scene.show_grid}_${pv.width_cells}_${this.world.scale.x}_${this.world.x}_${this.world.y}`;
        const pFrameHash = `${this.isGM}_${this.dragState.mode === 'move_player'}_${pv.x}_${pv.y}_${pv.width_cells}_${pv.aspect}_${this.scene.show_player_frame}`;
        
        if (viewChanged || this._cacheState.grid !== gridHash) {
            this._cacheState.grid = gridHash;
            const g = this.containers.grid; g.clear();
            g.blendMode = PIXI.BLEND_MODES.DIFFERENCE; 
            if(this.scene.show_grid) {
                g.lineStyle(1, 0xFFFFFF, 0.4); 
                const bounds = this.getVisibleBounds();
                const startX = Math.floor(bounds.x / gs) * gs; const startY = Math.floor(bounds.y / gs) * gs;
                const endX = bounds.x + bounds.width; const endY = bounds.y + bounds.height;
                for(let x=startX; x<=endX; x+=gs) { g.moveTo(x, bounds.y); g.lineTo(x, endY); }
                for(let y=startY; y<=endY; y+=gs) { g.moveTo(bounds.x, y); g.lineTo(endX, y); }
            }
        }
        
        if (viewChanged || this._cacheState.pFrame !== pFrameHash) {
            this._cacheState.pFrame = pFrameHash;
            const pf = this.containers.pFrame; pf.clear();
            if(this.isGM && this.scene.show_player_frame) {
                const w = pv.width_cells * gs; const h = w / pv.aspect;
                pf.lineStyle(4 / this.world.scale.x, 0x0088ff, 0.8);
                if(this.dragState.mode === 'move_player') pf.beginFill(0x0088ff, 0.1); 
                pf.drawRect(pv.x - w/2, pv.y - h/2, w, h);
                pf.endFill();
            }
        }
    }
    
    getVisibleBounds() {
        return {
            x: -this.world.x / this.world.scale.x,
            y: -this.world.y / this.world.scale.y,
            width: window.innerWidth / this.world.scale.x,
            height: window.innerHeight / this.world.scale.y
        };
    }

    getVisibleWorldBounds() {
        return {
            x: -this.world.x / this.world.scale.x,
            y: -this.world.y / this.world.scale.y,
            width: this.pixiApp.screen.width / this.world.scale.x,
            height: this.pixiApp.screen.height / this.world.scale.y
        };
    }

    drawWallCurve(g, p1, p2, curve) {
        const points = getWallPoints(p1, p2, curve);
        if(points.length > 0) {
            g.moveTo(points[0].x, points[0].y);
            for(let i=1; i<points.length; i++) g.lineTo(points[i].x, points[i].y);
        }
    }

    drawCurvedText(container, text, radius, centerAngle, color, ringWidth = 10, centered = true, maxAngle = null) {
        if(!text) return;
        let fontSize = 12 * (ringWidth / 10);
        let t = text;
        // Fitting für Segmente: Text so skalieren/kürzen, dass er in den verfügbaren Bogen passt.
        if (centered && maxAngle) {
            const availablePx = maxAngle * radius * 0.82; // Sicherheitsabstand zu den Segmentkanten
            let charW = fontSize * 0.62;
            const needed = t.length * charW;
            if (needed > availablePx) {
                fontSize = Math.max(7, fontSize * (availablePx / needed));
            }
            charW = fontSize * 0.62;
            const maxChars = Math.floor(availablePx / charW);
            if (t.length > maxChars) {
                t = t.slice(0, Math.max(1, maxChars - 1)) + '.';
            }
        }
        const textStyle = new PIXI.TextStyle({ fontSize, fill: 0xffffff, fontWeight: 'bold', dropShadow: true, dropShadowAlpha: 1, dropShadowBlur: 1.5, dropShadowDistance: 1.5, dropShadowColor: '#000000', padding: 5 });
        const charWidthApprox = fontSize * 0.62; 
        const charSpacing = charWidthApprox / radius; 
        // Zeichen belegen (n-1) Abstände – mit n Abständen wäre der Text um eine halbe
        // Zeichenbreite nach links verschoben (Zentrierungsfehler).
        const spanCount = Math.max(1, t.length - 1);
        const totalArc = spanCount * charSpacing;
        // centered=true: Kurve ist um centerAngle zentriert (für Segmente).
        // centered=false: startet oben (-PI/2) – für Einzelring, damit er von beiden Seiten lesbar bleibt.
        const startArc = centered ? (centerAngle - totalArc / 2) : (startAngleFromOffset(centerAngle) - totalArc / 2);

        for(let i=0; i<t.length; i++) {
            const char = t[i];
            const txt = new PIXI.Text(char, textStyle); txt.resolution = 4; txt.anchor.set(0.5, 0.5);
            const angle = startArc + i * charSpacing;
            txt.position.set(Math.cos(angle) * radius, Math.sin(angle) * radius);
            txt.rotation = angle + Math.PI/2;
            txt.scale.set(0.8); container.addChild(txt);
        }
    }

    // Hilfsfunktion: Helligkeit eines Hex-Farbwerts anpassen (+ = heller, - = dunkler)
    shadeColor(hex, percent) {
        const c = hex.replace('#','');
        const num = parseInt(c.length === 3 ? c.split('').map(x=>x+x).join('') : c, 16);
        const amt = Math.round(2.55 * percent);
        const R = Math.min(255, Math.max(0, (num >> 16) + amt));
        const G = Math.min(255, Math.max(0, ((num >> 8) & 0x00FF) + amt));
        const B = Math.min(255, Math.max(0, (num & 0x0000FF) + amt));
        return (0x1000000 + R * 0x10000 + G * 0x100 + B).toString(16).slice(1);
    }

    // Baut EIN Canvas für einen Ring (alle Segmente) mit glattem radialem Bevel.
    // Der radial verläufende Farbübergang (hell innen → dunkel außen) wirkt an allen
    // Kanten – auch an den Segment-Schnittkanten → jedes Segment wirkt wie ein eigenes Objekt.
    // Rückgabe: { canvas, scale } – scale = Auflösungsfaktor (Canvas-Pixel pro Welt-Pixel).
    buildRingCanvas(ring, innerR, outerR) {
        const segments = ring.segments || [{ color: '#2a2a2a', text: '' }];
        const thickness = outerR - innerR;
        const centerR = (innerR + outerR) / 2;
        const scale = Math.max(1, Math.min(4, (this.world ? this.world.scale.x : 1) * 2));
        const pad = Math.ceil(thickness * 0.3) + 2;
        const size = Math.ceil((outerR + pad) * 2 * scale);
        const canvas = document.createElement('canvas');
        canvas.width = size; canvas.height = size;
        const ctx = canvas.getContext('2d');
        ctx.setTransform(scale, 0, 0, scale, size/2, size/2);

        const drawSegment = (a0, a1, color) => {
            const col = color || '#2a2a2a';
            const light = this.shadeColor(col, 46);
            const dark = this.shadeColor(col, -46);
            const grad = ctx.createRadialGradient(0, 0, innerR, 0, 0, outerR);
            grad.addColorStop(0, light);
            grad.addColorStop(0.28, this.shadeColor(col, 18));
            grad.addColorStop(0.5, col);
            grad.addColorStop(0.72, this.shadeColor(col, -10));
            grad.addColorStop(1, dark);
            ctx.beginPath();
            ctx.arc(0, 0, outerR, a0, a1);
            ctx.arc(0, 0, innerR, a1, a0, true);
            ctx.closePath();
            ctx.fillStyle = grad;
            ctx.fill();
        };

        if (segments.length === 1) {
            // Voller Ring
            drawSegment(0, Math.PI * 2, segments[0].color || '#2a2a2a');
        } else {
            // Segmentierter Ring: Bogenstücke mit Lücke
            const segGap = 0.09;
            const totalAngle = Math.PI * 2;
            const segAngle = (totalAngle - segments.length * segGap) / segments.length;
            let startA = -Math.PI / 2;
            segments.forEach((seg, si) => {
                const a0 = startA + si * (segAngle + segGap);
                const a1 = a0 + segAngle;
                drawSegment(a0, a1, seg.color || '#2a2a2a');
            });
        }
        return { canvas, scale };
    }

    drawTokenRings(container, token) {
        if(!token.rings || token.rings.length === 0) return;
        const ringWidth = this.scene.ring_thickness || 10;
        const gap = 4; // fester Freiraum zwischen Ringen (unabhängig von der Ringdicke)
        const baseRadius = (token.size / 2) + 6;
        if(!container._ringTextures) container._ringTextures = [];
        token.rings.forEach((ring, idx) => {
             const centerR = baseRadius + idx * (ringWidth + gap) + ringWidth/2;
             const segments = ring.segments || [{ color: '#2a2a2a', text: '' }];
             const innerR = centerR - ringWidth/2;
             const outerR = centerR + ringWidth/2;

             // Ein Canvas + ein Sprite pro Ring
             const { canvas, scale } = this.buildRingCanvas(ring, innerR, outerR);
             const tex = PIXI.Texture.from(canvas);
             container._ringTextures.push(tex);
             const sprite = new PIXI.Sprite(tex);
             sprite.anchor.set(0.5);
             sprite.scale.set(1 / scale);
             container.addChild(sprite);

             // Text
             if(segments.length === 1) {
                 if(segments[0].text) {
                     this.drawCurvedText(container, segments[0].text, centerR, 0, 0xffffff, ringWidth, false);
                     this.drawCurvedText(container, segments[0].text, centerR, Math.PI, 0xffffff, ringWidth, false);
                 }
             } else {
                 const segGap = 0.09;
                 const totalAngle = Math.PI * 2;
                 const segAngle = (totalAngle - segments.length * segGap) / segments.length;
                 let startA = -Math.PI / 2;
                 segments.forEach((seg, si) => {
                     if(!seg.text) return;
                     const a0 = startA + si * (segAngle + segGap);
                     const a1 = a0 + segAngle;
                     const midA = (a0 + a1) / 2;
                     this.drawCurvedText(container, seg.text, centerR, midA, 0xffffff, ringWidth, true, segAngle);
                 });
             }
        });
    }

    renderTokens() {
        const activeTokenIds = new Set();
        let anyMoved = false;

        Object.values(this.scene.tokens).forEach(t => {
            // Token werden NUR angezeigt, wenn ein Blob zugewiesen UND aktuell sichtbar ist.
            // Ohne sichtbaren Blob (abandoned / verloren) verschwinden sie von der Karte.
            // Altes Verhalten: Token mit blob_id werden gerendert, auch wenn der Blob
            // kurz verdeckt ist – sie bleiben an ihrer gespeicherten Position.
            if (!t.blob_id) return;
            
            activeTokenIds.add(t.uuid);
            
            let tc = this.tokenCache[t.uuid];
            if(!tc) {
                tc = new PIXI.Container();
                this.tokenCache[t.uuid] = tc;
                this.containers.tokens.addChild(tc);
                tc.x = t.x; tc.y = t.y; 
                tc._cachedProps = null; 
            }

            const isSelected = (this.isGM && this.scene.tokens[this.selectedObjId] === t);
            
            // Grober Ring-Hash statt JSON.stringify (weniger Serialisierung pro Render)
            let ringsHash = '';
            if (t.rings && t.rings.length) {
                ringsHash = t.rings.map(g => {
                    const segs = g.segments || [];
                    return segs.map(s => (s.color||'') + ':' + (s.text||'').length).join(',');
                }).join('|');
            }
            const currentProps = `${t.name}_${t.spotlight_color}_${t.size}_${isSelected}_${this.isGM}_${t.blob_id || ''}_${this.scene.show_blob_ids}_${ringsHash}_${t.vision_range}_${this.scene.ring_thickness}_${this.scene.token_name_size}`;

            if (tc._cachedProps !== currentProps) {
                while (tc.children.length > 0) tc.removeChildAt(0).destroy();
                const color = t.spotlight_color ? parseInt(t.spotlight_color.replace('#',''),16) : 0xffffff;
                const g = new PIXI.Graphics();
                g.beginFill(color, 1.0); g.drawCircle(0,0, t.size / 2); g.endFill();
                const blurAmount = Math.max(1, 16 * this.world.scale.x);
                if (!tc._blurFilter) tc._blurFilter = new PIXI.BlurFilter(blurAmount);
                else tc._blurFilter.blur = blurAmount;
                g.filters = [tc._blurFilter];
                tc.addChild(g);
                this.drawTokenRings(tc, t);

                if (isSelected) {
                    const ring = new PIXI.Graphics();
                    ring.lineStyle(2, 0xffffff, 0.8); ring.drawCircle(0,0, t.size / 2 + 2);
                    tc.addChild(ring);
                }

                if (t.name) {
                     const ringOffset = (t.rings ? t.rings.length * (this.scene.ring_thickness || 10) : 0);
                     const nameSize = this.scene.token_name_size || 12;
                     const txt = new PIXI.Text(t.name, {fontSize:nameSize, fill:0xffffff, stroke:0x000000, strokeThickness:3});
                     txt.anchor.set(0, 0.5); txt.x = (t.size/2) + 5 + ringOffset; 
                     tc.addChild(txt);
                }
                
                if (this.isGM && t.blob_id && this.scene.show_blob_ids) {
                     const ringOffset = (t.rings ? t.rings.length * (this.scene.ring_thickness || 10) : 0);
                     const idTxt = new PIXI.Text(t.blob_id, {fontSize:13, fill:0x00ff00, fontWeight:'bold', stroke:0x000000, strokeThickness:2});
                     idTxt.anchor.set(0, 1); idTxt.position.set((t.size/2) + ringOffset, -((t.size/2) + 5));
                     tc.addChild(idTxt);
                }
                tc._cachedProps = currentProps;
            } else {
                 if(tc.children.length > 0 && tc.children[0].filters) {
                     const blurAmount = Math.max(1, 16 * this.world.scale.x);
                     if (Math.abs(tc.children[0].filters[0].blur - blurAmount) > 0.5) tc.children[0].filters[0].blur = blurAmount;
                 }
            }

            // SMOOTHNESS FIX: Increase lerp factor for more responsive movement
            const lerpFactor = 0.5; 
            const dist = Math.hypot(tc.x - t.x, tc.y - t.y);
            if (dist > 0.5) {
                if (dist > 200) { tc.x = t.x; tc.y = t.y; } 
                else { tc.x = lerp(tc.x, t.x, lerpFactor); tc.y = lerp(tc.y, t.y, lerpFactor); }
                anyMoved = true;
            } else { tc.x = t.x; tc.y = t.y; }
        });
        
        Object.keys(this.tokenCache).forEach(k => {
            if(!activeTokenIds.has(k)) {
                const tc = this.tokenCache[k];
                if (tc._blurFilter) tc._blurFilter.destroy();
                tc.destroy({children:true});
                delete this.tokenCache[k];
            }
        });
        return anyMoved;
    }

    onResize() { 
        if(this.pixiApp) {
            this.pixiApp.resize();
            this.requestRender();
        } 
    }
}