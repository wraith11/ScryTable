export function getInitialState() {
    return {
        isGM: new URLSearchParams(window.location.search).get('view') === 'gm',
        // Sprache: URL-Parameter ?lang=xx > localStorage > Standard 'en'
        lang: (new URLSearchParams(window.location.search).get('lang') || localStorage.getItem('lt_lang') || 'en'),
        serverIp: 'localhost',
        tab: 'tools',
        tool: 'select',
        showCalibration: false,
        showColorPicker: false, 
        availableCameras: [],
        saveMapName: "",
        mapList: [],
        showTokenColorPopup: false,
        activeColorMode: null, 
        activeRingIndex: null,
        assetList: [],
        currentAssetPath: '',
        
        // NEU: Media Browser
        mediaList: [],
        selectedMediaSlot: 0, // 0..3

        snapMode: true,
        rightClickStart: {x:0, y:0},
        isRightClickPan: false,
        rightClickDidMove: false,
        
        toolSettings: { 
            invisibleWall: false, columnVertices: 0, wallWidth: 15, brushSize: 15,
            fowBrushRadius: 100, fowBrushMode: 'reveal',
            light: { radius: 300, brightness: 0.4, color_intensity: 0.1, color: '#ffaa00', flicker: false, flicker_strength: 50 }
        },
        
        scene: { 
            view: {x:0, y:0, scale:1.0},
            player_view: { x: 0, y: 0, width_cells: 28, aspect: 1.777 }, 
            objects:[], walls:[], lights:[], drawings:[], columns:[], tokens:{}, fow_shapes: [],
            fow_visited: [], fow_erased: [],
            fow_active: false, fow_mode: 'temporary', grid_size: 50, objects_locked: false,
            show_blob_ids: true,
            background_locked: false, show_light_icons: true, lights_active: true, 
            background_color: '#222222', 
            background_image: { url:null, x:0, y:0, scale:1.0, repeat:false, opacity:1.0 },
            show_grid: true, time_of_day: 'day',
            player_view_blackout: true, tracking_paused: false, show_player_frame: true,
            // Defaults für neue Tokens
            token_size_default: 45, ring_thickness: 10, token_name_size: 12, token_color_default: '#aaaaaa', vision_range_default: 400,
            
            // NEU: Blackout Config
            blackout_config: {
                mode: 'full', // 'full', 'split', 'quad'
                sync: true,
                screens: [
                    { url: null, type: 'image', loop: true, flipped: false }, 
                    { url: null, type: 'image', loop: true, flipped: false },
                    { url: null, type: 'image', loop: true, flipped: true },
                    { url: null, type: 'image', loop: true, flipped: true }
                ]
            }
        },
        
        camParams: { 
            camera_index: 0,
            threshold: 200, 
            corners: [[0,0],[1280,0],[1280,720],[0,720]], flip_x:false, flip_y:false,
            min_area: 10, max_area: 5000, smoothing: 0.2, hotspot_compensation: 0.0,
            merge_distance: 25, parallax_strength: 0.0, cam_pos_x: 0.5, cam_pos_y: 0.5
        },
        
        blobs: {}, 
        selObjId: null, selectedObjIsWall: false, selectedObjIsLight: false, selectedObjIsColumn: false,
        drawColor: '#ffffff', brushTexture: null, tilesPerAxis: 2, 
        drag: { active: false, start: {x:0,y:0}, mode: null, temp: null, worldStart: {x:0,y:0}, handle: null, offset: {x:0, y:0}, initialDist: 0, initialWidth: 0, initialHeight: 0 },
        camW: 1280, camH: 720, imgW: 2000, imgH: 720, cornerDragIdx: -1, tempCorners: [],
        colorPicker: null, openTokenId: null, lightColorPicker: null, tokenColorPicker: null,
        activeSegmentIndex: null,
        _lastSyncTime: 0, _syncTimer: null,
        currentMapName: "",
        _clipboard: null,
        _prevTokenSizeDefault: 45,
        _prevTokenColorDefault: '#aaaaaa',
        _prevVisionRangeDefault: 400
    };
}