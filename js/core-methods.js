import { socket } from './socket-client.js';

export const coreMethods = {
    // --- NEU: MEDIA METHODS ---
    refreshMedia() { socket.emit('request_media'); },
    
    setBlackoutMode(mode) {
        this.scene.blackout_config.mode = mode;
        const screens = this.scene.blackout_config.screens;
        if (mode === 'split') {
            screens[0].flipped = true;  
            screens[2].flipped = false; 
        } else if (mode === 'quad') {
            screens[0].flipped = true; screens[1].flipped = true;
            screens[2].flipped = false; screens[3].flipped = false;
        } else if (mode === 'full') {
            screens[0].flipped = false; 
        }
        if (mode === 'full') this.selectedMediaSlot = 0;
        else if (mode === 'split' && (this.selectedMediaSlot === 1 || this.selectedMediaSlot === 3)) this.selectedMediaSlot = 0;
        this.sync();
    },
    
    selectMediaSlot(idx) { this.selectedMediaSlot = idx; },
    
    assignMediaToSlot(item) {
        const conf = this.scene.blackout_config;
        const slotsToUpdate = conf.sync ? [0,1,2,3] : [this.selectedMediaSlot];
        slotsToUpdate.forEach(idx => { conf.screens[idx].url = item.url; conf.screens[idx].type = item.type; });
        this.sync();
    },
    
    clearMediaSlot(idx = -1) {
        const conf = this.scene.blackout_config;
        const slotsToUpdate = (idx === -1 || conf.sync) ? [0,1,2,3] : [idx];
        slotsToUpdate.forEach(i => { conf.screens[i].url = null; });
        this.sync();
    },
    
    toggleMediaFlip(idx) {
        if (this.scene.blackout_config.mode !== 'full') return;
        const conf = this.scene.blackout_config;
        const slotsToUpdate = conf.sync ? [0,1,2,3] : [idx];
        const newVal = !conf.screens[idx].flipped; 
        slotsToUpdate.forEach(i => conf.screens[i].flipped = newVal);
        this.sync();
    },
    
    toggleMediaLoop(idx) {
        const conf = this.scene.blackout_config;
        const slotsToUpdate = conf.sync ? [0,1,2,3] : [idx];
        const newVal = !conf.screens[idx].loop;
        slotsToUpdate.forEach(i => conf.screens[i].loop = newVal);
        this.sync();
    },

    // --- STANDARD CORE METHODS ---
    centerView() {
        if(this.isGM) {
            this.scene.view.x = window.innerWidth / 2;
            this.scene.view.y = window.innerHeight / 2;
            // Zoom auf 1.0 zurücksetzen (verhindert "zufällig hereingezoomt" beim Start)
            this.scene.view.scale = 1.0;
        }
    },
    onResize() { if(this.renderer) this.renderer.onResize(); },

    initColorPicker() {
        if(this.isGM) {
            this.colorPicker = new iro.ColorPicker("#color-picker-widget", { width: 180, layout: [{component: iro.ui.Wheel}, {component: iro.ui.Slider}] });
            this.colorPicker.on('color:change', (color) => {
                this.drawColor = color.hexString;
                this.brushTexture = null; 
            });

            this.tokenColorPicker = new iro.ColorPicker("#token-picker-widget", { 
                width: 160, 
                layout: [{ component: iro.ui.Wheel, options: {} }, { component: iro.ui.Slider, options: {} }]
            });
            
            this.tokenColorPicker.on('color:change', (color) => {
                // Modus "Default-Token-Farbe" braucht keinen offenen Token
                if (this.activeColorMode === 'default') {
                    this.scene.token_color_default = color.hexString;
                    this.applyTokenColorDefault();
                    return;
                }
                if(!this.openTokenId) return;
                const t = this.scene.tokens[this.openTokenId];
                if(!t) return;

                if (this.activeColorMode === 'spotlight') {
                    t.spotlight_color = color.hexString;
                    this.sync();
                } else if (this.activeColorMode === 'ring' && this.activeRingIndex !== null && this.activeSegmentIndex !== null) {
                    const group = t.rings && t.rings[this.activeRingIndex];
                    const seg = group && group.segments && group.segments[this.activeSegmentIndex];
                    if (seg) {
                        seg.color = color.hexString;
                        this.sync();
                    }
                }
            });
        }
    },
    updateLightColorPicker() {
        this.$nextTick(() => {
            const container = document.getElementById('light-cp');
            if(container && (this.selectedObjIsLight || this.tool === 'light')) {
                if(this.lightColorPicker) {
                    try { container.innerHTML = ''; } catch(e){}
                    this.lightColorPicker = null;
                }
                const settings = this.activeLightSettings;
                const currentColor = settings.color || '#ffaa00';
                this.lightColorPicker = new iro.ColorPicker(container, {
                    width: 140,
                    color: currentColor,
                    layout: [{ component: iro.ui.Wheel, options: {} }]
                });
                this.lightColorPicker.on('color:change', (color) => {
                    if(this.selectedObjIsLight && this.selectedObj) {
                        this.selectedObj.color = color.hexString;
                        this.renderer.lightsDirty = true;
                        this.sync();
                        this.renderer.startLightLoop();
                        this.renderer.requestRender();
                    } else {
                        this.toolSettings.light.color = color.hexString;
                    }
                });
            } else {
                this.lightColorPicker = null;
            }
        });
    },

    openTokenSpotlightPicker() {
        if (!this.openTokenId) return;
        const t = this.scene.tokens[this.openTokenId];
        this.activeColorMode = 'spotlight';
        this.activeRingIndex = null;
        this.tokenColorPicker.color.hexString = t.spotlight_color || '#aaaaaa';
        this.showTokenColorPopup = true;
    },

    resetTokenColor() {
        if (!this.openTokenId) return;
        const t = this.scene.tokens[this.openTokenId];
        t.spotlight_color = (this.scene.token_color_default || '#aaaaaa');
        this.sync();
    },

    openRingColorPicker(t, ringIdx, segIdx) {
        this.activeColorMode = 'ring';
        this.activeRingIndex = ringIdx;
        this.activeSegmentIndex = segIdx;
        const group = t.rings && t.rings[ringIdx];
        const seg = group && group.segments && group.segments[segIdx];
        if (seg) {
            const c = seg.color || '#2a2a2a';
            // Initialen grauen Zustand ignorieren: Picker auf 100% Helligkeit öffnen,
            // damit man nicht erst aufhellen muss, bevor man eine Farbe wählt.
            if (c === '#2a2a2a') this.tokenColorPicker.color.hexString = '#c0392b';
            else this.tokenColorPicker.color.hexString = c;
            this.showTokenColorPopup = true;
        }
    },

    // Öffnet den Colorpicker für die Default-Token-Farbe (Settings).
    openDefaultColorPicker() {
        this.activeColorMode = 'default';
        this.activeRingIndex = null;
        this.activeSegmentIndex = null;
        this.tokenColorPicker.color.hexString = this.scene.token_color_default || '#aaaaaa';
        this.showTokenColorPopup = true;
    },

    toggleLightsActive() {
        this.scene.lights_active = !this.scene.lights_active;
        this.sync();
        if(this.scene.lights_active && this.renderer) this.renderer.startLightLoop();
    },
    
    toggleLightIcons() {
        this.scene.show_light_icons = !this.scene.show_light_icons;
        if (!this.scene.show_light_icons) {
            if (this.selectedObjIsLight) {
                this.selObjId = null;
                this.selectedObjIsLight = false;
                if(this.renderer) this.renderer.selectedObjId = null;
            }
            if (this.tool === 'light') {
                this.setTool('select');
            }
        }
        this.sync();
    },

    setTool(t) {
        if (t === 'move_player' && this.tool === 'move_player') {
            this.tool = 'select';
            if (this.renderer) this.renderer.requestRender();
            return;
        }
        if(this.scene.objects_locked && !['select','move_player'].includes(t)) return;
        if(this.scene.background_locked) {
            if(['brush', 'grid_paint', 'rect_paint', 'circle_paint'].includes(t)) return;
        }
        this.tool = t; this.drag.mode = null; 
        if(t !== 'select') {
            this.selObjId = null; 
            this.selectedObjIsWall = false;
            this.selectedObjIsLight = false;
            this.selectedObjIsColumn = false;
            // Renderer-Auswahl zurücksetzen, damit der Auswahl-Rahmen verschwindet
            if(this.renderer) this.renderer.selectedObjId = null;
        }
        if(this.renderer) this.renderer.requestRender();
    },

    sync() { 
        socket.emit('update_scene', this.scene); 
        if (this.renderer) {
            this.renderer.mapDirty = true; 
            this.renderer.lightsDirty = true;
            this.renderer.startLightLoop();
            this.renderer.requestRender();
        }
    },
    // Gedrosselter Sync: lokal sofort rendern, Netzwerk-Broadcast auf ~20fps begrenzt.
    // Verhindert, dass bei jedem mousemove das komplette Scene-Objekt gesendet wird.
    // WICHTIG: Setzt KEIN mapDirty – das würde bei move_player/obj unnötig die Map neu
    // bauen und alle FoW-Sicht-Caches ungültig machen (Freeze bei FoW permanent).
    // Struktur-Änderungen (Wände/Säulen) setzen mapDirty selbst.
    syncThrottled() {
        if (this.renderer) {
            this.renderer.lightsDirty = true;
            this.renderer.startLightLoop();
            this.renderer.requestRender();
        }
        if (this._syncTimer) return;
        const now = Date.now();
        const wait = 50 - (now - (this._lastSyncTime || 0));
        if (wait <= 0) {
            socket.emit('update_scene', this.scene);
            this._lastSyncTime = now;
        } else {
            this._syncTimer = setTimeout(() => {
                this._syncTimer = null;
                socket.emit('update_scene', this.scene);
                this._lastSyncTime = Date.now();
            }, wait);
        }
    },
    // Bricht einen noch ausstehenden gedrosselten Sync ab und sendet sofort den finalen Zustand.
    flushSync() {
        if (this._syncTimer) { clearTimeout(this._syncTimer); this._syncTimer = null; }
        this.sync();
    },
    saveGame() { socket.emit('save_settings'); },
    
    // Speichern: überschreibt die aktuell geladene/gespeicherte Karte unter demselben Namen.
    saveCurrentMap() {
        if (!this.currentMapName) { this.saveMapAs(); return; }
        this._doSaveMap(this.currentMapName);
    },
    // Speichern unter: speichert unter dem im Eingabefeld stehenden Namen.
    saveMapAs() {
        if(!this.saveMapName) return;
        this._doSaveMap(this.saveMapName);
    },
    _doSaveMap(name) {
        // Aktuelle GM-View direkt mit dem Speichern übertragen, damit sie mitgespeichert wird
        socket.emit('save_map', { filename: name, view: this.scene.view }, (res) => {
            if(res.error) alert(this.t('errSave') + res.error);
            else {
                this.currentMapName = name;
                this.saveMapName = "";
                alert(this.t('mapSaved'));
            }
        });
    },
    loadMap(filename) {
        if(confirm(this.t('confirmLoad', filename))) {
            socket.emit('load_map', filename, (res) => {
                if(res.error) alert(this.t('errLoad') + res.error);
                else {
                    this.currentMapName = filename;
                    this.scene.player_view_blackout = true;
                    this.sync();
                }
            });
        }
    },
    // Gespeicherte Karte löschen
    deleteMap(filename) {
        if(!confirm(this.t('confirmDeleteMap', filename))) return;
        socket.emit('delete_map', filename, (res) => {
            if(res.error) alert(this.t('errDeleteMap') + res.error);
            else if(this.currentMapName === filename) { this.currentMapName = ""; }
        });
    },
    // Neue leere Karte erstellen (aktuelle Szene zurücksetzen)
    newMap() {
        if(!confirm(this.t('confirmNewMap'))) return;
        this.currentMapName = "";
        this.saveMapName = "";
        // Server-seitig leere Karte erzeugen; der zurückkommende init-Handler baut die
        // Scene frisch neu auf (garantiert ohne Hintergrund / alten Inhalt).
        socket.emit('new_map', (res) => {
            if(res && res.error) alert(this.t('errSave') + res.error);
        });
        // Lokal sofort leeren, damit kein alter Zustand zwischenzeitlich sichtbar bleibt
        if(this.scene.background_image) this.scene.background_image.url = null;
        this.scene.objects = []; this.scene.walls = []; this.scene.columns = [];
        this.scene.lights = []; this.scene.drawings = []; this.scene.fow_shapes = [];
        this.scene.fow_visited = []; this.scene.tokens = {};
        if(this.renderer) {
            this.renderer.resetFoWMemory();
            this.renderer.clearBackground();
            this.renderer.mapDirty = true;
            this.renderer.fowDirty = true;
            this.renderer.rebuildMap();
            this.renderer.requestRender();
        }
    },

    addObjectAt(pos, src, type) {
        const id = Date.now();
        const obj = {
            id: id, type: type || 'image', src: src, layer: 'object', z: 5,
            x: pos.x, y: pos.y, scale: 1.0, width: 100, height: 100, rotation: 0
        };
        this.scene.objects.push(obj);
        this.selObjId = id;
        // Relative Größe der Assets zueinander beibehalten, aber in den richtigen Maßstab
        // zu Feldern/Figuren umgerechnet: Ein 400px-Asset entspricht ~1 Grid-Zelle.
        if ((type || 'image') === 'image') {
            const img = new Image();
            img.onload = () => {
                if (img.naturalWidth > 0 && img.naturalHeight > 0) {
                    const gs = this.scene.grid_size || 50;
                    const scaleFactor = gs / 400;
                    obj.width = Math.max(1, Math.round(img.naturalWidth * scaleFactor));
                    obj.height = Math.max(1, Math.round(img.naturalHeight * scaleFactor));
                    this.renderer.mapDirty = true;
                    this.sync();
                    this.renderer.requestRender();
                }
            };
            img.src = src;
        }
        this.renderer.mapDirty = true;
        this.sync();
        return obj;
    },

    deleteSelected() { 
        if(this.selObjId) { 
            if(this.selectedObjIsLight) {
                this.scene.lights = this.scene.lights.filter(l=>l.id!==this.selObjId);
                if(this.renderer) this.renderer.lightsDirty = true;
            }
            else if(this.selectedObjIsWall) {
                this.scene.walls = this.scene.walls.filter(w=>w.id!==this.selObjId);
                if(this.renderer) this.renderer.mapDirty = true;
            }
            else if(this.selectedObjIsColumn) {
                this.scene.columns = this.scene.columns.filter(c=>c.id!==this.selObjId);
                if(this.renderer) this.renderer.mapDirty = true;
            }
            else {
                this.scene.objects = this.scene.objects.filter(o=>o.id!==this.selObjId); 
                if(this.renderer) this.renderer.mapDirty = true;
            }
            this.selObjId=null; 
            this.sync(); 
            // BUGFIX: Renderer-Auswahl zurücksetzen, damit der Auswahl-Rahmen sofort verschwindet
            if(this.renderer) { this.renderer.selectedObjId = null; this.renderer.requestRender(); }
        }
    },
    
    changeLayer(delta) {
        if(this.selectedObj) { 
            let newZ = (this.selectedObj.z || 0) + delta;
            if(this.selectedObjIsWall || this.selectedObjIsColumn) {
                newZ = Math.max(0, Math.min(15, newZ)); 
            } else if(!this.selectedObjIsLight) {
                newZ = Math.max(-5, Math.min(15, newZ)); 
            }
            this.selectedObj.z = newZ;
            this.sync(); 
            // BUGFIX: Overlay Farbe sofort updaten
            if(this.renderer) this.renderer.requestRender();
        }
    },

    toggleLock() {
        this.scene.objects_locked = !this.scene.objects_locked;
        this.sync();
        if(this.scene.objects_locked) {
            this.setTool('select'); 
        }
    },
    toggleBlackout() { 
        this.scene.player_view_blackout = !this.scene.player_view_blackout; 
        socket.emit('toggle_blackout', {active: this.scene.player_view_blackout}); 
    },
    toggleTracking() {
        this.scene.tracking_paused = !this.scene.tracking_paused;
        this.sync();
    },
    resetFoW() {
        if (confirm(this.t('confirmFowReset'))) {
            this.scene.fow_visited = [];
            this.sync();
            if(this.renderer) {
                this.renderer.fowDirty = true;
                this.renderer.updateFoWMemory(true);
                this.renderer.requestRender();
            }
        }
    },
    
    openCalibration() { 
        this.showCalibration = true; 
        this.tempCorners = JSON.parse(JSON.stringify(this.camParams.corners)); 
        this.$nextTick(() => { 
            const img = this.$refs.calibImg;
            if(img) {
                img.onload = () => {
                    this.imgW = img.naturalWidth;
                    this.imgH = img.naturalHeight;
                };
                if (img.complete && img.naturalWidth > 0) {
                    this.imgW = img.naturalWidth;
                    this.imgH = img.naturalHeight;
                }
            }
        }); 
    },
    updateCamParams() { socket.emit('update_cam_params', this.camParams); },
    resetCamera() {
        if(confirm(this.t('confirmCamReset'))) {
            socket.emit('reset_camera');
        }
    },
    openCameraSettings() {
        socket.emit('open_camera_settings');
    },
    
    refreshCameras() { socket.emit('refresh_cameras'); },
    setCamera(idx) { socket.emit('change_camera', idx); },

    navigateAssets(path) { this.currentAssetPath = path; socket.emit('request_assets', {path: path}); },
    navigateUp() { if(!this.currentAssetPath) return; const parts = this.currentAssetPath.split('/'); parts.pop(); this.navigateAssets(parts.join('/')); },
    clickAsset(a) {
        if(a.type === 'folder') { this.navigateAssets(a.path); }
        else { this.brushTexture = a.url; }
    },
    handleBgUpload(e) {
        const file = e.target.files[0]; if(!file) return;
        const reader = new FileReader();
        reader.onload = (evt) => {
             socket.emit('upload_asset', {name: file.name, data: evt.target.result, path: this.currentAssetPath}, (res) => {
                 if(res && res.url) { 
                     this.scene.background_image.url = res.url;
                     // Wiederholen standardmäßig aus (nur bei Bedarf aktivierbar)
                     this.scene.background_image.repeat = false;
                     const pv = this.scene.player_view;
                     this.scene.background_image.scale = 1.0; this.scene.background_image.x = 0; this.scene.background_image.y = 0; 
                     this.sync();
                     // BUGFIX: Force Render nach Upload
                     if(this.renderer) {
                         this.renderer.mapDirty = true;
                         this.renderer.requestRender();
                     }
                 }
             });
        };
        reader.readAsDataURL(file);
    },
    
    handleFileUpload(e) {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (evt) => {
            socket.emit('upload_asset', {name: file.name, data: evt.target.result, path: this.currentAssetPath}, (res) => {
                if (res && res.url) {
                    if (['brush', 'grid_paint', 'rect_paint', 'circle_paint', 'wall'].includes(this.tool)) {
                        this.brushTexture = res.url;
                    }
                }
            });
        };
        reader.readAsDataURL(file);
    },

    fixVerticesSelected() {
        let v = this.selectedObj.vertices;
        if(v > 0 && v < 3) this.selectedObj.vertices = 3;
        this.sync();
    },
    fixVerticesTool() {
        let v = this.toolSettings.columnVertices;
        if(v > 0 && v < 3) this.toolSettings.columnVertices = 3;
    },
    checkMigrations() {
        if(this.scene.drawings) this.scene.drawings.forEach(d => { if(!d.id) d.id = 'd_' + Math.random().toString(36).substr(2, 9); });
        if(this.scene.walls) this.scene.walls.forEach(w => { if(!w.id) w.id = 'w_'+Math.random().toString(36).substr(2,9); if(w.curve===undefined) w.curve=0; });
        if(this.scene.lights) this.scene.lights.forEach(l => { if(!l.id) l.id = 'l_'+Math.random().toString(36).substr(2,9); });
        if(!this.scene.columns) this.scene.columns = [];
        if(!this.scene.background_image) this.scene.background_image = { url:null, x:0, y:0, scale:1.0, repeat:false, opacity:1.0 };
        if(!this.scene.time_of_day) this.scene.time_of_day = 'day';
        if(!this.scene.fow_mode) this.scene.fow_mode = 'temporary';
        if(this.scene.show_blob_ids === undefined) this.scene.show_blob_ids = true;
        if(this.scene.background_locked === undefined) this.scene.background_locked = false;
        if(this.scene.show_light_icons === undefined) this.scene.show_light_icons = true;
        if(this.scene.lights_active === undefined) this.scene.lights_active = true;
        if(!this.scene.fow_visited) this.scene.fow_visited = [];
        if(this.scene.show_player_frame === undefined) this.scene.show_player_frame = true;
        // Migration: Altes Ring-Format (flaches Array von {color,text}) → Gruppenmodell
        // {segments:[{color,text}]}. Jeder alte Ring wird zu einer Gruppe mit einem Segment.
        if(this.scene.tokens) {
            Object.values(this.scene.tokens).forEach(t => {
                if(t.rings && Array.isArray(t.rings) && t.rings.length > 0 && t.rings[0].segments === undefined) {
                    t.rings = t.rings.map(r => ({ segments: [{ color: r.color || '#2a2a2a', text: r.text || '' }] }));
                } else if(t.rings) {
                    // Sicherstellen, dass jedes Segment-Objekt existiert
                    t.rings.forEach(g => { if(!g.segments) g.segments = [{ color: '#2a2a2a', text: '' }]; });
                }
            });
        }
        
        if(!this.scene.blackout_config) {
            this.scene.blackout_config = {
                mode: 'full', sync: true,
                screens: [
                    { url: null, type: 'image', loop: true, flipped: false }, 
                    { url: null, type: 'image', loop: true, flipped: false },
                    { url: null, type: 'image', loop: true, flipped: true },
                    { url: null, type: 'image', loop: true, flipped: true }
                ]
            };
        }
    },

    createToken() { 
        const id = crypto.randomUUID(); 
        this.scene.tokens[id] = { 
            uuid: id, name: 'Neu', x: (this.renderer.pixiApp.screen.width/2 - this.scene.view.x) / this.scene.view.scale, 
            y: (this.renderer.pixiApp.screen.height/2 - this.scene.view.y) / this.scene.view.scale,
            on_board: false, blob_id: null, has_vision: false, vision_range: 400, 
            spotlight_color: (this.scene.token_color_default || '#aaaaaa'), size: (this.scene.token_size_default || 45), style: 'ring', hp: 10, max_hp: 10, show_hp: false,
            markers: [{},{},{},{},{}], rings: [], modified: true 
        }; 
        this.sync(); 
        this.openTokenId = id;
    },
    
    // Ein neuer Ring (= Gruppe mit einem Segment) anlegen.
    addTokenRing(t) {
        if(!t.rings) t.rings = [];
        t.rings.push({ segments: [{ color: '#2a2a2a', text: '' }] });
        this.sync();
    },
    // Wendet die geänderte Standard-Token-Größe auf alle Tokens mit der bisherigen
    // Standardgröße an (damit bestehende Tokens sofort mit aktualisiert werden).
    applyTokenSizeDefault() {
        const newDefault = this.scene.token_size_default || 45;
        Object.values(this.scene.tokens).forEach(t => {
            // Nur Tokens anpassen, die (noch) die alte Standardgröße tragen
            if (t.size === this._prevTokenSizeDefault || t.size === 45) {
                t.size = newDefault;
            }
        });
        this._prevTokenSizeDefault = newDefault;
        this.sync();
        if(this.renderer) this.renderer.requestRender();
    },
    // Wendet die geänderte Standard-Token-Farbe auf alle Tokens mit der bisherigen
    // Standardfarbe an (damit bestehende Tokens sofort mit aktualisiert werden).
    applyTokenColorDefault() {
        const newDefault = this.scene.token_color_default || '#aaaaaa';
        Object.values(this.scene.tokens).forEach(t => {
            if (t.spotlight_color === this._prevTokenColorDefault || t.spotlight_color === '#aaaaaa') {
                t.spotlight_color = newDefault;
            }
        });
        this._prevTokenColorDefault = newDefault;
        this.sync();
        if(this.renderer) this.renderer.requestRender();
    },
    // Ein neues Segment (Status) an einen bestehenden Ring anhängen.
    // Max. 8 Segmente pro Ring (24 Stati pro Token).
    addTokenSegment(t, ringIdx) {
        if(!t.rings) t.rings = [];
        if(ringIdx === undefined || ringIdx === null || !t.rings[ringIdx]) return;
        if(t.rings[ringIdx].segments.length >= 8) return;
        t.rings[ringIdx].segments.push({ color: '#2a2a2a', text: '' });
        this.sync();
    },
    // Ein Segment aus einem Ring entfernen; leere Ringe werden entfernt.
    removeTokenSegment(t, ringIdx, segIdx) {
        if(!t.rings || !t.rings[ringIdx] || !t.rings[ringIdx].segments) return;
        t.rings[ringIdx].segments.splice(segIdx, 1);
        if(t.rings[ringIdx].segments.length === 0) t.rings.splice(ringIdx, 1);
        this.sync();
    },
    // Dupliziert einen Status als weiteres Segment im selben Ring (max. 8 pro Ring).
    duplicateStatusAsSegment(t, ringIdx, segIdx) {
        if(!t.rings || !t.rings[ringIdx] || !t.rings[ringIdx].segments) return;
        const seg = t.rings[ringIdx].segments[segIdx];
        if(!seg || t.rings[ringIdx].segments.length >= 8) return;
        t.rings[ringIdx].segments.splice(segIdx + 1, 0, { color: seg.color, text: seg.text });
        this.sync();
    },
    // Dupliziert einen Status als eigenen neuen Ring (max. 4 Ringe).
    duplicateStatusAsRing(t, ringIdx, segIdx) {
        if(!t.rings) t.rings = [];
        const seg = t.rings[ringIdx] && t.rings[ringIdx].segments && t.rings[ringIdx].segments[segIdx];
        if(!seg || t.rings.length >= 4) return;
        t.rings.push({ segments: [{ color: seg.color, text: seg.text }] });
        this.sync();
    },
    removeTokenRing(t, index) {
        if(t.rings && t.rings[index]) { t.rings.splice(index, 1); this.sync(); }
    },
    
    blinkToken(t) {
        const originalColor = t.spotlight_color;
        const blink = (count) => {
            if(count <= 0) { t.spotlight_color = originalColor; this.sync(); return; }
            t.spotlight_color = '#000000';
            this.sync();
            setTimeout(() => {
                t.spotlight_color = originalColor;
                this.sync();
                setTimeout(() => blink(count - 1), 200);
            }, 200);
        };
        blink(3);
    },
    
    deleteToken(id) { delete this.scene.tokens[id]; this.sync(); },
    toggleTokenDetails(id, event) {
        if (this.openTokenId === id) this.openTokenId = null;
        else this.openTokenId = id;
    },
    linkBlob(t) {
        if(t.blob_id) {
            Object.values(this.scene.tokens).forEach(other => {
                if (other.uuid !== t.uuid && other.blob_id === t.blob_id) {
                    other.blob_id = null; 
                    if (!other.modified) delete this.scene.tokens[other.uuid];
                }
            });
            if(this.blobs[String(t.blob_id)]) {
                // Sofort an die aktuelle Blob-Position setzen (Token haben keine eigene Position)
                const pv = this.scene.player_view;
                const w = pv.width_cells * this.scene.grid_size;
                const h = w / pv.aspect;
                const b = this.blobs[String(t.blob_id)];
                t.x = (pv.x - w/2) + b.x * w;
                t.y = (pv.y - h/2) + b.y * h;
                t.on_board = true;
                this.updateTokenPos();
            }
            t.on_board = true;
            this.markTokenModified(t); 
            // BUGFIX: Sicht sofort aufdecken, sobald ein Token einem Blob zugewiesen wird
            this.revealTokenVision(t);
        }
        this.sync();
    },

    // BUGFIX: Deckt bei permanentem FoW die Sicht am aktuellen Token-Ort sofort auf
    // (ohne auf die nächste Bewegung warten zu müssen).
    revealTokenVision(t) {
        if (!t || !t.has_vision) return;
        if (!this.scene.fow_active || this.scene.fow_mode !== 'permanent') return;
        if (!t._lastFowPos || Math.hypot(t.x - t._lastFowPos.x, t.y - t._lastFowPos.y) > 25) {
            const pt = { x: Math.round(t.x), y: Math.round(t.y), radius: t.vision_range || 400 };
            this.scene.fow_visited.push(pt);
            this._fowDeltaBuffer.push(pt);
            t._lastFowPos = {x: t.x, y: t.y};
            this.flushFowDelta();
            if (this.renderer) {
                this.renderer.fowDirty = true;
                this.renderer.requestRender();
            }
        }
    },
    toggleTokenVision(t) {
        t.has_vision = !t.has_vision;
        if (t.has_vision) this.revealTokenVision(t);
        this.markTokenModified(t);
    },
    markTokenModified(t) {
        if (!t.modified) { t.modified = true; }
        this.sync();
    },
    
    handleBlobs(data) {
        let changes = false;
        const pv = this.scene.player_view;
        const w = pv.width_cells * this.scene.grid_size;
        const h = w / pv.aspect;
        const viewX = pv.x - w/2;
        const viewY = pv.y - h/2;

        for (const bid of Object.keys(data.blobs)) {
            const tokenExists = Object.values(this.scene.tokens).some(t => String(t.blob_id) === String(bid));
            if (!tokenExists) {
                const b = data.blobs[bid];
                const initX = viewX + b.x * w;
                const initY = viewY + b.y * h;
                const id = crypto.randomUUID();
                this.scene.tokens[id] = {
                    uuid: id, name: "", blob_id: String(bid), 
                    x: initX, y: initY, 
                    on_board: true, has_vision: false, vision_range: 400,
                    spotlight_color: (this.scene.token_color_default || '#aaaaaa'), size: (this.scene.token_size_default || 45), style: 'dot',
                    markers: [{},{},{},{},{}], rings: [], modified: false
                };
                changes = true;
            }
        }

        const visibleIds = Object.keys(data.blobs).map(String);
        const tokensToDelete = [];
        const ghostIds = (data.lost_ids || []).map(String);
        
        Object.values(this.scene.tokens).forEach(t => {
            if (t.blob_id) {
                const bIdStr = String(t.blob_id);
                const isVisible = visibleIds.includes(bIdStr);
                const isGhost = ghostIds.includes(bIdStr);

                // Original-Logik: Token nur abmelden, wenn der Blob weder sichtbar noch im
                // Ghost-Zustand (lost_ids) ist. Das Backend hält verdeckte Blobs bis zum
                // Ghost-Timeout in lost_ids → Token bleiben bei kurzer Verdeckung erhalten.
                if (!isVisible && !isGhost) {
                    if (t.modified) { 
                        t.blob_id = null; 
                        t.on_board = false; 
                    } 
                    else { tokensToDelete.push(t.uuid); }
                    changes = true;
                }
            }
        });

        tokensToDelete.forEach(uuid => { delete this.scene.tokens[uuid]; });
        if (changes) this.sync();
    },
    
    // A2: Puffer für neue fow_visited-Punkte, die als Delta gesendet werden
    _fowDeltaBuffer: [],
    _fowFullTimer: null,
    _fowFullCount: 0,

    // A2: Neue Sicht-Punkte als Delta senden (nicht die ganze Szene).
    // Zusätzlich alle FOW_FULL_INTERVAL Sekunden den vollständigen Stand zum Abgleich senden.
    flushFowDelta() {
        if (this._fowDeltaBuffer.length === 0) return;
        const points = this._fowDeltaBuffer;
        this._fowDeltaBuffer = [];
        socket.emit('fow_visited_delta', { points });
        this._fowFullCount += points.length;
        if (this._fowFullCount >= 200) { this.emitFowFull(); this._fowFullCount = 0; }
    },
    emitFowFull() {
        socket.emit('fow_visited_full', { points: this.scene.fow_visited });
    },
    startFowSync() {
        if (this._fowFullTimer) return;
        this._fowFullTimer = setInterval(() => this.emitFowFull(), 10000);
    },
    stopFowSync() {
        if (this._fowFullTimer) { clearInterval(this._fowFullTimer); this._fowFullTimer = null; }
    },

    updateTokenPos() {
        let changed = false;
        let tokenListChanged = false;
        const pv = this.scene.player_view; 
        const w = pv.width_cells * this.scene.grid_size; 
        const h = w / pv.aspect;
        const viewX = pv.x - w/2;
        const viewY = pv.y - h/2;
        const margin = this.scene.grid_size; 
        
        const isPermanent = this.scene.fow_active && this.scene.fow_mode === 'permanent';
        let fowChanged = false;

        Object.values(this.scene.tokens).forEach(t => {
            try {
                // Original-Logik: Token außerhalb der Player-View werden abgemeldet
                // (dort kann es keine Blobs geben).
                const inView = (t.x >= viewX - margin && t.x <= viewX + w + margin && 
                                t.y >= viewY - margin && t.y <= viewY + h + margin);
                if (!inView && t.blob_id) {
                    t.blob_id = null; 
                    t.on_board = false;
                    if (!t.modified) {
                        delete this.scene.tokens[t.uuid];
                        tokenListChanged = true;
                    } else {
                        changed = true;
                    }
                    return;
                }

                if (this.scene.tracking_paused) return;

                if(t.blob_id && this.blobs[String(t.blob_id)]) {
                    const b = this.blobs[String(t.blob_id)]; 
                    let targetX = viewX + b.x * w; 
                    let targetY = viewY + b.y * h;
                    const dx = targetX - t.x;
                    const dy = targetY - t.y;
                    const dist = Math.hypot(dx, dy);

                    if (dist > 3.0) { 
                        t.x = targetX; 
                        t.y = targetY; 
                        changed = true; 
                        
                        if (isPermanent && t.has_vision) {
                             const vr = t.vision_range || 400;
                             if (!t._lastFowPos || Math.hypot(t.x - t._lastFowPos.x, t.y - t._lastFowPos.y) > 25) {
                                 const pt = {
                                     x: Math.round(t.x), 
                                     y: Math.round(t.y), 
                                     radius: vr
                                 };
                                 this.scene.fow_visited.push(pt);
                                 this._fowDeltaBuffer.push(pt);
                                 t._lastFowPos = {x: t.x, y: t.y};
                                 fowChanged = true;
                             }
                        }
                    } 
                }
            } catch (err) {
                // BUGFIX: Ein einzelner Token/Blob darf den Rest nicht abreißen
                console.warn("updateTokenPos token error", err);
            }
        });
        
        if (fowChanged) this.flushFowDelta();
        if (tokenListChanged) this.sync();
        
        if (this.renderer) {
             if (fowChanged) this.renderer.fowDirty = true;
             if (changed) this.renderer.requestRender();
        }
    }
};