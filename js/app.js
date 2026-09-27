import { GameRenderer } from './renderer.js';
import { getInitialState } from './state.js';
import { interactionMethods } from './interactions.js';
import { coreMethods } from './core-methods.js';
import { socket } from './socket-client.js';
import { translations } from './i18n.js';

const { createApp } = Vue;

createApp({
    data() {
        const state = getInitialState();
        state.blobListKeys = []; 
        return state;
    },
    created() {
        this.renderer = null;
    },
    computed: {
        sortedTokens() { 
            return Object.values(this.scene.tokens).sort((a,b) => {
                if (a.modified && !b.modified) return -1;
                if (!a.modified && b.modified) return 1;
                return a.name.localeCompare(b.name);
            }); 
        },
        availableBlobs() { return this.blobListKeys; },
        selectedObj() { 
            if(this.selectedObjIsLight) return this.scene.lights.find(l => l.id === this.selObjId);
            if(this.selectedObjIsWall) return this.scene.walls.find(w => w.id === this.selObjId);
            if(this.selectedObjIsColumn) return this.scene.columns.find(c => c.id === this.selObjId);
            return this.scene.objects.find(o => o.id === this.selObjId); 
        },
        activeLightSettings() {
            if (this.selectedObjIsLight && this.selectedObj) return this.selectedObj;
            return this.toolSettings.light;
        },
        assetBreadcrumbs() {
            if(!this.currentAssetPath) return [];
            const parts = this.currentAssetPath.split('/');
            let acc = '';
            return parts.map(p => { acc += (acc?'/':'')+p; return {name:p, full:acc}; });
        },
        // Kamera-Positions-Ansicht: cam_pos (Werte -2..3, Bildmitte=0.5) → Anzeige-Prozent
        camPosViewX() {
            return ((this.camParams.cam_pos_x + 2) / 5) * 100;
        },
        camPosViewY() {
            return ((this.camParams.cam_pos_y + 2) / 5) * 100;
        }
    },
    watch: {
        selObjId(newVal) { this.updateLightColorPicker(); },
        tool(newVal) { if(newVal === 'light') this.updateLightColorPicker(); },
        'scene.player_view': {
            handler() { this.updateTokenPos(); },
            deep: true
        }
    },
    
    // Mixin all Logic
    methods: {
        ...interactionMethods,
        ...coreMethods,

        // --- Kamera-Positions-Ansicht (Draggen des Kreuzes) ---
        startCamPosDrag(e) {
            this._camPosDragging = true;
            this.onCamPosMove(e);
        },
        onCamPosMove(e) {
            if (!this._camPosDragging) return;
            const rect = this.$refs.camPosView.getBoundingClientRect();
            if (!rect.width) return;
            const px = ((e.clientX - rect.left) / rect.width) * 100;
            const py = ((e.clientY - rect.top) / rect.height) * 100;
            // Anzeige-Prozent → cam_pos-Wert (-2..3)
            const vx = (px / 100) * 5 - 2;
            const vy = (py / 100) * 5 - 2;
            this.camParams.cam_pos_x = Math.max(-2, Math.min(3, Math.round(vx * 10) / 10));
            this.camParams.cam_pos_y = Math.max(-2, Math.min(3, Math.round(vy * 10) / 10));
            this.updateCamParams();
        },
        stopCamPosDrag() {
            this._camPosDragging = false;
        },

        // i18n: liefert den übersetzten String für den aktuellen Zustand (lang).
        // Format-Platzhalter wie '%s' werden mit args ersetzt.
        t(key, ...args) {
            const dict = translations[this.lang] || translations.en || {};
            let s = dict[key] !== undefined ? dict[key] : (translations.en[key] !== undefined ? translations.en[key] : key);
            if (args && args.length) {
                args.forEach(a => { s = s.replace('%s', a); });
            }
            return s;
        },
        // Sprache setzen (persistiert in localStorage, wirkt sofort auf alle UI-Texte).
        setLang(lang) {
            if (translations[lang]) {
                this.lang = lang;
                try { localStorage.setItem('lt_lang', lang); } catch(e){}
            }
        },

        setupEventListeners() {
            window.addEventListener('mousedown', this.onDown);
            window.addEventListener('mousemove', this.onMove);
            window.addEventListener('mouseup', this.onUp);
            window.addEventListener('wheel', this.onWheel, { passive: false });
            // Rechtsklick-Kontextmenü unterdrücken: `@contextmenu.prevent` auf #app reicht
            // in Firefox nicht zuverlässig, deshalb global auf window. (Rechtsklick = Pan)
            window.addEventListener('contextmenu', this.onContextMenu);
            window.addEventListener('dragover', (e) => e.preventDefault());
            window.addEventListener('drop', this.dropFile);
        },
        removeEventListeners() {
            window.removeEventListener('mousedown', this.onDown);
            window.removeEventListener('mousemove', this.onMove);
            window.removeEventListener('mouseup', this.onUp);
            window.removeEventListener('wheel', this.onWheel);
            window.removeEventListener('contextmenu', this.onContextMenu);
            window.removeEventListener('dragover', (e) => e.preventDefault());
            window.removeEventListener('drop', this.dropFile);
        },
    },

    mounted() {
        this.renderer = new GameRenderer(this.scene, this.isGM);
        this.renderer.init();
        
        this.renderer.onTokenClick = (t) => {
            if(this.isGM) {
                this.tab = 'tokens';
                this.openTokenId = t.uuid;
            }
        };

        this.centerView();
        this.setupEventListeners();
        this.$nextTick(() => this.initColorPicker());
        window.addEventListener('resize', this.onResize);
        window.addEventListener('keydown', this.onKeyDown);
        
        // --- Socket Init ---
        socket.emit('request_assets', {path: ''});
        // NEU: Media Liste anfordern
        if(this.isGM) socket.emit('request_media');

        socket.on('init', (data) => { 
            this.scene = {...this.scene, ...data}; 
            if(this.renderer) {
                this.renderer.scene = this.scene;
                this.checkMigrations(); 
                this.renderer.rebuildFoW(); 
                this.renderer.rebuildMap();
                this.renderer.drawingsDirty = true; 
                this.renderer.lightsDirty = true; // BUGFIX: Lights dirty setzen beim init
                // BUGFIX: Nach Refresh Tag/Nacht-Übergang (Darkness) starten, sonst bleibt es bei "Tag"
                this.renderer.startLightLoop();
                this.renderer.requestRender(); 
            }
        });
        
        socket.on('update_scene', (data) => { 
            let fullRefresh = false;
            Object.keys(data).forEach(k => {
                if (k === 'view') return; 

                if(k === 'player_view') this.scene.player_view = {...this.scene.player_view, ...data[k]};
                else if(k === 'background_image') { this.scene.background_image = {...this.scene.background_image, ...data[k]}; fullRefresh = true; }
                else if (['walls','columns','objects'].includes(k)) { this.scene[k] = data[k]; fullRefresh = true; }
                else if (k === 'lights') { this.scene[k] = data[k]; if(this.renderer) this.renderer.lightsDirty = true; }
                else if (k === 'fow_shapes') { this.scene[k] = data[k]; if(this.renderer) this.renderer.rebuildFoW(); }
                else if (k === 'drawings') { this.scene[k] = data[k]; if(this.renderer) this.renderer.drawingsDirty = true; }
                else this.scene[k] = data[k];
            });
            if(this.renderer) {
                this.renderer.scene = this.scene;
                this.checkMigrations();
                if (fullRefresh) this.renderer.mapDirty = true;
                this.renderer.startLightLoop();
                this.renderer.requestRender();
            }
        });
        
        socket.on('camera_resolution', (res) => {
            this.camW = res.w;
            this.camH = res.h;
            // BUGFIX: Ecken NICHT überschreiben! Nur Auflösung speichern.
            // Die Ecken kommen separat über 'cam_params_sync'
        });

        socket.on('cam_params_sync', (data) => { this.camParams = data; });
        
        socket.on('blob_update', (data) => { 
            if(this.scene.tracking_paused) return;
            this.blobs = data.blobs; 
            const newKeys = Object.keys(data.blobs).sort();
            const oldKeys = this.blobListKeys.sort(); 
            let changed = newKeys.length !== oldKeys.length;
            if(!changed) {
                for(let i=0; i<newKeys.length; i++) {
                    if(newKeys[i] !== oldKeys[i]) { changed = true; break; }
                }
            }
            if(changed) {
                this.blobListKeys = Object.keys(data.blobs);
            }
            if(this.renderer) this.renderer.setBlobs(this.blobs);
            if (this.isGM) this.handleBlobs(data); 
            this.updateTokenPos(); 
            if(this.renderer) this.renderer.requestRender();
        });
        
        socket.on('asset_list_update', (data) => { if(this.currentAssetPath === data.path) this.assetList = data.items; });
        socket.on('map_list_update', (list) => { this.mapList = list; });
        socket.on('server_info', (info) => { this.serverIp = info.ip; });
        
        // NEU: Media List Update
        socket.on('media_list_update', (list) => { this.mediaList = list; });
        
        // NEU: Empfange Kamera Liste
        socket.on('available_cameras', (cams) => { this.availableCameras = cams; });
        
        // A2: fow_visited Delta/Full empfangen (auf jedem Client anwenden)
        // Kein direktes updateFoWMemory(true) – renderFoW bakt inkrementell (false).
        socket.on('fow_visited_delta', (data) => {
            const points = data.points || [];
            if (points.length === 0) return;
            if (!this.scene.fow_visited) this.scene.fow_visited = [];
            this.scene.fow_visited.push(...points);
            if (this.renderer) {
                this.renderer.fowDirty = true;
                this.renderer.requestRender();
            }
        });
        socket.on('fow_visited_full', (data) => {
            const points = data.points || [];
            this.scene.fow_visited = points;
            if (this.renderer) {
        socket.on('fow_erased_delta', (data) => {
            const points = data.points || [];
            if (points.length === 0) return;
            if (!this.scene.fow_erased) this.scene.fow_erased = [];
            this.scene.fow_erased.push(...points);
            if (this.renderer) {
                this.renderer.fowDirty = true;
                this.renderer.requestRender();
            }
        });
        socket.on('fow_erased_full', (data) => {
            const points = data.points || [];
            this.scene.fow_erased = points;
            if (this.renderer) {
                this.renderer.fowDirty = true;
                this.renderer.requestRender();
            }
        });
                this.renderer.fowDirty = true;
                this.renderer.requestRender();
            }
        });
        // A2: Periodischer Vollabgleich nur auf der GM-Seite senden
        if (this.isGM) this.startFowSync();
        
        // --- PERFORMANCE OPTIMIZATION: REMOVED PERMANENT TICKER ---
        // The render loop is now event-driven via requestRender()
    },
    beforeUnmount() { 
        this.removeEventListeners(); 
        window.removeEventListener('keydown', this.onKeyDown);
        this.stopFowSync();
    }
}).mount('#app');