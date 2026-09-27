import { getWallPoints, distToSegment } from './utils.js';
import { socket } from './socket-client.js';

export const interactionMethods = {
    onDown(e) {
        if(e.target.closest('#sidebar') || e.target.closest('.modal-overlay') || e.target.closest('#context-menu') || e.target.closest('.color-picker-popover') || e.target.tagName === 'BUTTON' || e.target.tagName === 'INPUT') return;
        if(!this.isGM || !this.renderer) return;

        const pos = this.renderer.getWorldPos(e);
        const viewScale = this.scene.view.scale; 
        
        if(e.button === 2) { 
            this.rightClickStart = {x: e.clientX, y: e.clientY};
            this.isRightClickPan = false;
            this.rightClickDidMove = false;
            this.drag.active = true;
            this.drag.start = {x:e.clientX, y:e.clientY}; 
            return; 
        }

        if(this.drag.mode === 'stamp' && this.brushTexture) {
                if(this.scene.objects_locked) return;
                this.addObjectAt(pos, this.brushTexture, 'image');
                this.drag.active = false; return;
        }

        this.drag.active = true;
        this.drag.start = {x:e.clientX, y:e.clientY}; 
        this.drag.worldStart = pos;
        // BUGFIX: Stale drag.mode zurücksetzen (z. B. 'pan' nach Rechtsklick), damit
        // ein Linksklick nicht versehentlich weiter die Sicht verschiebt.
        this.drag.mode = null;

        if(this.tool === 'eraser' || e.button === 1) {
            if(this.scene.objects_locked) return; e.preventDefault();
            
            const finishDelete = () => {
                this.drag.active = false; 
                this.sync(); 
                // FORCE RENDER: Ensure the renderer knows something changed immediately
                if (this.renderer) {
                    this.renderer.mapDirty = true;
                    this.renderer.drawingsDirty = true;
                    this.renderer._renderDirty = true;
                    this.renderer.requestRender();
                }
            };

            const hitLightIndex = this.scene.lights.findIndex(l => Math.hypot(pos.x-l.x, pos.y-l.y) <= 20/viewScale);
            if(hitLightIndex !== -1) { 
                this.scene.lights.splice(hitLightIndex, 1); 
                this.renderer.lightsDirty = true; 
                finishDelete(); return; 
            }
            
            const hitColIndex = this.scene.columns.findIndex(c => Math.hypot(pos.x-c.x, pos.y-c.y) <= c.radius);
            if(hitColIndex !== -1) { 
                if (this.scene.background_locked && (this.scene.columns[hitColIndex].z !== undefined ? this.scene.columns[hitColIndex].z : 10) < 0) {} 
                else {
                    this.scene.columns.splice(hitColIndex, 1); 
                    this.renderer.mapDirty = true; 
                    finishDelete(); return; 
                }
            }
            
            let hitObjId = null;
            for(let i=this.scene.objects.length-1; i>=0; i--) {
                const o = this.scene.objects[i];
                if (this.scene.background_locked && (o.z !== undefined ? o.z : 5) < 0) continue;
                if(pos.x > o.x - o.width/2 && pos.x < o.x + o.width/2 && pos.y > o.y - o.height/2 && pos.y < o.y + o.height/2) { hitObjId = o.id; break; }
            }
            if(hitObjId) { 
                this.scene.objects = this.scene.objects.filter(o => o.id !== hitObjId); 
                this.renderer.mapDirty = true; 
                finishDelete(); return; 
            }
            
            const hitWallIndex = this.scene.walls.findIndex(w => {
                if (this.scene.background_locked && (w.z !== undefined ? w.z : 5) < 0) return false;
                if(w.curve) {
                        const pts = getWallPoints({x:w.x1, y:w.y1}, {x:w.x2, y:w.y2}, w.curve);
                        for(let j=0; j<pts.length-1; j++) { if(distToSegment(pos, pts[j], pts[j+1]) < 20/viewScale) return true; }
                        return false;
                } else { 
                    return distToSegment(pos, {x:w.x1, y:w.y1}, {x:w.x2, y:w.y2}) <= 20/viewScale; 
                }
            });
            if(hitWallIndex !== -1) { 
                this.scene.walls.splice(hitWallIndex, 1); 
                this.renderer.mapDirty = true; 
                finishDelete(); return; 
            }
            
            if (!this.scene.background_locked) {
                let hitDrawIndex = -1;
                for(let i=this.scene.drawings.length-1; i>=0; i--) {
                    const item = this.scene.drawings[i]; let hit = false;
                    if(item.type === 'path') hit = item.points.some(p => Math.hypot(pos.x-p.x, pos.y-p.y) < (item.size||15));
                    else if(item.type === 'grid_paint') hit = item.cells.some(c => pos.x >= c.x && pos.x < c.x + 50 && pos.y >= c.y && pos.y < c.y + 50);
                    else if(item.type.includes('rect')) hit = (pos.x > item.x && pos.x < item.x + item.w && pos.y > item.y && pos.y < item.y + item.h);
                    else if(item.type.includes('circle')) hit = Math.hypot(pos.x - item.x, pos.y - item.y) <= item.radius;
                    if(hit) { hitDrawIndex = i; break; }
                }
                if(hitDrawIndex !== -1) { 
                    this.scene.drawings.splice(hitDrawIndex, 1); 
                    this.renderer.drawingsDirty = true; 
                    finishDelete(); return; 
                }
            }
            return;
        }

        if(this.tool === 'select') {
            for (let t of Object.values(this.scene.tokens)) {
                if (!t.blob_id) continue;
                const dist = Math.hypot(pos.x - t.x, pos.y - t.y);
                if (dist <= t.size / 2) {
                    this.openTokenId = t.uuid; 
                    return;
                }
            }

            if(this.scene.objects_locked) return; 
            
            const handleHit = 15 / viewScale;

            if(this.selectedObj) {
                const o = this.selectedObj;
                if(this.selectedObjIsLight) {
                    if (!this.scene.show_light_icons) return;
                    if(Math.hypot(pos.x - o.x, pos.y - o.y) < 20/viewScale) { this.drag.mode = 'light'; return; }
                }
                
                if(this.selectedObjIsColumn) {
                    const rot = (o.rotation || 0) * (Math.PI/180);
                    const hDist = o.radius + (30 / viewScale);
                    const topPt = {x: o.x + Math.sin(rot)*hDist, y: o.y - Math.cos(rot)*hDist};
                    if(Math.hypot(pos.x - topPt.x, pos.y - topPt.y) < handleHit) { this.drag.mode = 'rotate'; return; } 
                    
                    const resizePt = {x: o.x + Math.sin(rot + Math.PI/4)*o.radius, y: o.y - Math.cos(rot + Math.PI/4)*o.radius};
                    if(Math.hypot(pos.x - resizePt.x, pos.y - resizePt.y) < handleHit) { this.drag.mode = 'resize_column'; return; }

                    if(Math.hypot(pos.x - o.x, pos.y - o.y) < o.radius) { this.drag.mode = 'column_move'; return; }
                }
                
                if(this.selectedObjIsWall) {
                    if(Math.hypot(pos.x - o.x1, pos.y - o.y1) < 20/viewScale) { this.drag.mode = 'wall_drag'; this.drag.handle='p1'; return; }
                    if(Math.hypot(pos.x - o.x2, pos.y - o.y2) < 20/viewScale) { this.drag.mode = 'wall_drag'; this.drag.handle='p2'; return; }
                    let hit = false;
                    if(o.curve) {
                            const pts = getWallPoints({x:o.x1, y:o.y1}, {x:o.x2, y:o.y2}, o.curve);
                            for(let i=0; i<pts.length-1; i++) { if(distToSegment(pos, pts[i], pts[i+1]) < 20/viewScale) { hit=true; break; } }
                    } else { if(distToSegment(pos, {x:o.x1,y:o.y1}, {x:o.x2,y:o.y2}) < 20/viewScale) hit=true; }
                    if(hit) { this.drag.mode = 'wall_move'; this.drag.offset = {x: o.x1 - pos.x, y: o.y1 - pos.y}; return; }
                } else if(!this.selectedObjIsLight && !this.selectedObjIsWall && !this.selectedObjIsColumn) {
                    const w = o.width; const h = o.height;
                    const angle = (o.rotation || 0) * (Math.PI/180);
                    const cos = Math.cos(angle), sin = Math.sin(angle);
                    const dx = pos.x - o.x, dy = pos.y - o.y;
                    const lx = dx * cos + dy * sin, ly = -dx * sin + dy * cos;
                    
                    const corners = [{x: -w/2, y: -h/2}, {x: w/2, y: -h/2}, {x: w/2, y: h/2}, {x: -w/2, y: h/2}];
                    for(let c of corners) {
                        if(Math.abs(lx - c.x) < handleHit && Math.abs(ly - c.y) < handleHit) {
                            this.drag.mode = 'resize'; 
                            this.drag.initialDist = Math.hypot(pos.x - o.x, pos.y - o.y); 
                            this.drag.initialWidth = o.width; 
                            this.drag.initialHeight = o.height; 
                            return;
                        }
                    }

                    const handleDistScreen = 30 / viewScale;
                    const hTop = {x: 0, y: -h/2 - handleDistScreen};
                    if(Math.abs(lx - hTop.x) < handleHit && Math.abs(ly - hTop.y) < handleHit) { this.drag.mode = 'rotate'; return; }

                    if(Math.abs(lx) < w/2 && Math.abs(ly) < h/2) { this.drag.mode = 'obj'; return; }
                }
            }

            this.selectedObjIsWall = false; this.selectedObjIsLight = false; this.selectedObjIsColumn = false; this.selObjId = null;
            
            for(let i=this.scene.lights.length-1; i>=0; i--) {
                const l = this.scene.lights[i];
                if(!this.scene.show_light_icons) continue;
                if(Math.hypot(pos.x - l.x, pos.y - l.y) < 20/viewScale) { this.selObjId = l.id; this.selectedObjIsLight = true; this.drag.mode = 'light'; return; }
            }
            for(let i=this.scene.columns.length-1; i>=0; i--) {
                const c = this.scene.columns[i];
                if (this.scene.background_locked && (c.z !== undefined ? c.z : 10) < 0) continue;
                if(Math.hypot(pos.x - c.x, pos.y - c.y) < c.radius) { this.selObjId = c.id; this.selectedObjIsColumn = true; this.drag.mode = 'column_move'; return; }
            }
            for(let i=this.scene.objects.length-1; i>=0; i--) {
                const o = this.scene.objects[i];
                if (this.scene.background_locked && (o.z !== undefined ? o.z : 5) < 0) continue;
                if(pos.x > o.x - o.width/2 && pos.x < o.x + o.width/2 && pos.y > o.y - o.height/2 && pos.y < o.y + o.height/2) { this.selObjId = o.id; this.drag.mode='obj'; return; }
            }
            for(let i=this.scene.walls.length-1; i>=0; i--) {
                const w = this.scene.walls[i];
                // Unsichtbare Wände sind im Select-Tool anklickbar (GM)
                if (this.scene.background_locked && (w.z !== undefined ? w.z : 5) < 0) continue;

                let hit = false;
                if(w.curve) {
                        const pts = getWallPoints({x:w.x1, y:w.y1}, {x:w.x2, y:w.y2}, w.curve);
                        for(let i=0; i<pts.length-1; i++) { if(distToSegment(pos, pts[i], pts[i+1]) < 20/viewScale) { hit=true; break; } }
                } else { if(distToSegment(pos, {x:w.x1, y:w.y1}, {x:w.x2, y:w.y2}) < 20/viewScale) hit=true; }
                if(hit) { this.selObjId = w.id; this.selectedObjIsWall = true; this.drag.mode='wall_move'; this.drag.offset = {x: w.x1 - pos.x, y: w.y1 - pos.y}; return; }
            }
        }
        
        if(this.selectedObj) { this.selObjId = null; }
        
        if(this.tool === 'move_player') { 
            this.drag.mode='move_player';
            if(!this.scene.tracking_paused) {
                this.scene.tracking_paused = true;
                this.sync();
            }
            return; 
        }
        
        // Snapping auf halbes Grid (Schnittpunkte) – Ausnahme: Kreis-Hintergrund-Tool
        const halfGrid = (this.scene.grid_size || 50) / 2;
        const snap = (v) => Math.round(v/halfGrid)*halfGrid;
        
        if(this.tool === 'wall') { 
            this.drag.mode='wall'; 
            const sx = this.snapMode ? snap(pos.x) : pos.x; const sy = this.snapMode ? snap(pos.y) : pos.y;
            this.drag.temp={x1:sx, y1:sy, x2:sx, y2:sy, texture: this.brushTexture, tilesPerAxis: this.tilesPerAxis, id: 'temp_'+Date.now(), curve: 0, width: this.toolSettings.wallWidth, z: 5, invisible: this.toolSettings.invisibleWall}; 
        }
        else if(this.tool === 'column') {
            this.drag.mode='column';
            const csx = this.snapMode ? snap(pos.x) : pos.x; const csy = this.snapMode ? snap(pos.y) : pos.y;
            this.drag.temp={x:csx, y:csy, radius:10, id:'temp_'+Date.now(), vertices: this.toolSettings.columnVertices, rotation: 0, color: this.drawColor, texture: this.brushTexture, tilesPerAxis: this.tilesPerAxis, z: 10};
        }
        else if(this.tool === 'brush') { 
            this.drag.mode='brush'; 
            this.drag.temp={id:'d_'+Date.now(), type:'path', color:this.drawColor, size:this.toolSettings.brushSize, points:[pos], texture:this.brushTexture, tilesPerAxis:this.tilesPerAxis}; 
            this.renderer.requestRender(); 
        }
        else if(this.tool === 'fow_paint') {
            this.drag.mode='fow_paint';
            this.drag.temp={ points: [], last: null };
            this.applyFoWBrush(pos);
        }
        else if(this.tool === 'grid_paint') { this.drag.mode='grid_paint'; this.drag.temp={id:'d_'+Date.now(), type:'grid_paint', cells:[{x:Math.floor(pos.x/50)*50, y:Math.floor(pos.y/50)*50}], color:this.drawColor, texture:this.brushTexture, tilesPerAxis:this.tilesPerAxis}; this.renderer.requestRender(); }
        else if(this.tool === 'rect_paint') { 
            this.drag.mode='rect_paint'; 
            const startX = this.snapMode ? Math.floor(pos.x/50)*50 : pos.x;
            const startY = this.snapMode ? Math.floor(pos.y/50)*50 : pos.y;
            const initialW = this.snapMode ? 50 : 0;
            const initialH = this.snapMode ? 50 : 0;
            this.drag.temp={id:'d_'+Date.now(), type:'rect_paint', x:startX, y:startY, w:initialW, h:initialH, color:this.drawColor, texture:this.brushTexture, startX:startX, startY:startY, tilesPerAxis:this.tilesPerAxis}; 
            this.renderer.requestRender();
        }
        else if(this.tool === 'circle_paint') { this.drag.mode='circle_paint'; const csx2 = this.snapMode ? snap(pos.x) : pos.x; const csy2 = this.snapMode ? snap(pos.y) : pos.y; this.drag.temp={id:'d_'+Date.now(), type:'circle_paint', x:csx2, y:csy2, radius:1, color:this.drawColor, size:this.toolSettings.brushSize, texture:this.brushTexture, tilesPerAxis:this.tilesPerAxis}; this.renderer.requestRender(); }
        else if(this.tool === 'light') {
            let hitLightId = null;
            if (this.scene.show_light_icons) {
                for(let i=this.scene.lights.length-1; i>=0; i--) {
                    const l = this.scene.lights[i];
                    if(Math.hypot(pos.x - l.x, pos.y - l.y) < 20/viewScale) {
                        hitLightId = l.id;
                        break;
                    }
                }
            }
            
            if (hitLightId) {
                this.selObjId = hitLightId;
                this.selectedObjIsLight = true;
                this.drag.mode = 'light';
            } else {
                const id = 'l_'+Date.now();
                const settings = this.toolSettings.light;
                this.scene.lights.push({
                    id: id, 
                    x:pos.x, 
                    y:pos.y, 
                    radius: settings.radius, 
                    color: settings.color, 
                    brightness: settings.brightness, 
                    color_intensity: settings.color_intensity, 
                    flicker: settings.flicker,
                    flicker_strength: settings.flicker_strength
                }); 
                this.selObjId = id; 
                this.selectedObjIsLight = true; 
                this.renderer.lightsDirty = true; 
                this.sync(); 
                this.drag.active=false;
            }
        }
        this.renderer.setToolSettings(this.toolSettings, this.drawColor, this.brushTexture, this.tilesPerAxis);
        this.renderer.setDragState(this.drag, this.selObjId);
        this.renderer.requestRender();
    },

    onMove(e) {
        if(!this.isGM || !this.drag.active || !this.renderer) return;
        
        if(e.buttons === 2) { 
            const dist = Math.hypot(e.clientX - this.rightClickStart.x, e.clientY - this.rightClickStart.y);
            if(dist > 5) {
                this.isRightClickPan = true;
                this.rightClickDidMove = true;
                this.drag.mode = 'pan';
            }
        }

        if(this.drag.mode === 'pan') {
            const dx = e.clientX - this.drag.start.x; const dy = e.clientY - this.drag.start.y;
            this.scene.view.x += dx; this.scene.view.y += dy;
            this.drag.start = {x:e.clientX, y:e.clientY};
            this.renderer.requestRender();
            return;
        }

        const pos = this.renderer.getWorldPos(e);
        // Snapping auf halbes Grid (Schnittpunkte) – Ausnahme: Kreis-Hintergrund-Tool
        const halfGrid = (this.scene.grid_size || 50) / 2;
        const snap = (v) => Math.round(v/halfGrid)*halfGrid;

        if(this.drag.mode === 'wall') {
            this.drag.temp.x2 = this.snapMode ? snap(pos.x) : pos.x; 
            this.drag.temp.y2 = this.snapMode ? snap(pos.y) : pos.y;
            this.renderer.requestRender(); 
        }
        else if(this.drag.mode === 'column') {
            const dist = Math.hypot(pos.x - this.drag.temp.x, pos.y - this.drag.temp.y);
            this.drag.temp.radius = Math.max(10, dist);
            this.renderer.requestRender();
        }
        else if(this.drag.mode === 'brush') { 
            const lastPt = this.drag.temp.points[this.drag.temp.points.length - 1];
            if (Math.hypot(pos.x - lastPt.x, pos.y - lastPt.y) > 4) {
                this.drag.temp.points.push(pos);
                this.renderer.requestRender();
            }
        }
        else if(this.drag.mode === 'fow_paint') {
            const last = this.drag.temp.last;
            const step = Math.max(5, this.toolSettings.fowBrushRadius * 0.3);
            if (!last || Math.hypot(pos.x - last.x, pos.y - last.y) >= step) {
                this.applyFoWBrush(pos);
                this.drag.temp.last = {x: pos.x, y: pos.y};
            }
        }
        else if(this.drag.mode === 'grid_paint') {
            const gx = Math.floor(pos.x/50)*50; const gy = Math.floor(pos.y/50)*50;
            if(!this.drag.temp.cells.some(c => c.x===gx && c.y===gy)) { this.drag.temp.cells.push({x:gx, y:gy}); this.renderer.requestRender(); }
        }
        else if(this.drag.mode === 'rect_paint') {
            if (this.snapMode) {
                const startCellX = this.drag.temp.startX; 
                const startCellY = this.drag.temp.startY;
                const currentCellX = Math.floor(pos.x / 50) * 50;
                const currentCellY = Math.floor(pos.y / 50) * 50;
                const x1 = Math.min(startCellX, currentCellX);
                const y1 = Math.min(startCellY, currentCellY);
                const x2 = Math.max(startCellX, currentCellX) + 50; 
                const y2 = Math.max(startCellY, currentCellY) + 50;
                this.drag.temp.x = x1; this.drag.temp.y = y1;
                this.drag.temp.w = x2 - x1; this.drag.temp.h = y2 - y1;
            } else {
                const sx = this.drag.temp.startX; const sy = this.drag.temp.startY;
                this.drag.temp.x = Math.min(sx, pos.x);
                this.drag.temp.y = Math.min(sy, pos.y);
                this.drag.temp.w = Math.abs(pos.x - sx);
                this.drag.temp.h = Math.abs(pos.y - sy);
            }
            this.renderer.requestRender();
        }
        else if(this.drag.mode === 'circle_paint') {
            this.drag.temp.radius = Math.hypot(pos.x - this.drag.temp.x, pos.y - this.drag.temp.y);
            this.renderer.requestRender();
        }
        else if(this.drag.mode === 'move_player') {
            const gs = this.scene.grid_size;
            const pv = this.scene.player_view;
            if(this.snapMode) { pv.x = Math.round(pos.x/gs)*gs; pv.y = Math.round(pos.y/gs)*gs; } 
            else { pv.x = pos.x; pv.y = pos.y; }
            this.syncThrottled();
        }
        else if(this.selectedObj) {
                const o = this.selectedObj;
                if(this.drag.mode === 'obj') {
                    if(this.snapMode) { o.x = snap(pos.x); o.y = snap(pos.y); } else { o.x = pos.x; o.y = pos.y; }
                    this.renderer.mapDirty = true; // Objekt-Sprite-Position aktualisieren
                    this.syncThrottled();
                }
                else if(this.drag.mode === 'light' && this.selectedObjIsLight) {
                    if(this.snapMode) { o.x = snap(pos.x); o.y = snap(pos.y); } else { o.x = pos.x; o.y = pos.y; }
                    this.renderer.lightsDirty = true;
                    this.syncThrottled();
                }
                else if(this.drag.mode === 'column_move' && this.selectedObjIsColumn) {
                    if(this.snapMode) { o.x = snap(pos.x); o.y = snap(pos.y); } else { o.x = pos.x; o.y = pos.y; }
                    this.renderer.fowDirty = true;
                    this.renderer.mapDirty = true;
                    this.syncThrottled();
                }
                else if(this.drag.mode === 'resize') {
                    const dist = Math.hypot(pos.x - o.x, pos.y - o.y);
                    const scale = dist / this.drag.initialDist;
                    o.width = this.drag.initialWidth * scale; o.height = this.drag.initialHeight * scale;
                    if(this.snapMode) { o.width = snap(o.width); o.height = snap(o.height); }
                    this.renderer.mapDirty = true; // Sprite-Größe aktualisieren
                    this.syncThrottled();
                }
                else if(this.drag.mode === 'resize_column') {
                    const dist = Math.hypot(pos.x - o.x, pos.y - o.y);
                    o.radius = Math.max(10, dist); 
                    this.renderer.fowDirty = true;
                    this.renderer.mapDirty = true;
                    this.syncThrottled();
                }
                else if(this.drag.mode === 'rotate') {
                    o.rotation = (Math.atan2(pos.y - o.y, pos.x - o.x) * 180 / Math.PI) + 90;
                    if(this.snapMode) o.rotation = Math.round(o.rotation / 45) * 45;
                    this.renderer.mapDirty = true; // Sprite-Rotation aktualisieren
                    this.syncThrottled();
                }
                else if(this.drag.mode === 'wall_move') {
                    if(this.snapMode) {
                        const dx = snap(pos.x + this.drag.offset.x) - o.x1;
                        const dy = snap(pos.y + this.drag.offset.y) - o.y1;
                        o.x1 += dx; o.y1 += dy; o.x2 += dx; o.y2 += dy;
                    } else {
                        const w = o.x2 - o.x1; const h = o.y2 - o.y1;
                        o.x1 = pos.x + this.drag.offset.x; o.y1 = pos.y + this.drag.offset.y;
                        o.x2 = o.x1 + w; o.y2 = o.y1 + h;
                    }
                    this.renderer.fowDirty = true;
                    this.renderer.mapDirty = true;
                    this.syncThrottled();
                }
                else if(this.drag.mode === 'wall_drag') {
                    if(this.drag.handle === 'p1') { o.x1 = this.snapMode ? snap(pos.x) : pos.x; o.y1 = this.snapMode ? snap(pos.y) : pos.y; }
                    else { o.x2 = this.snapMode ? snap(pos.x) : pos.x; o.y2 = this.snapMode ? snap(pos.y) : pos.y; }
                    this.renderer.fowDirty = true;
                    this.renderer.mapDirty = true;
                    this.syncThrottled();
                }
        }
        this.renderer.setToolSettings(this.toolSettings, this.drawColor, this.brushTexture, this.tilesPerAxis);
        this.renderer.setDragState(this.drag, this.selObjId);
        this.renderer.requestRender();
    },

    onUp(e) {
        if(!this.drag.active || !this.renderer) return;
        this.drag.active = false;
        
        if(e.button === 2) {
            if (!this.rightClickDidMove) {
                    this.setTool('select');
            }
            this.isRightClickPan = false;
            this.rightClickDidMove = false;
            this.renderer.requestRender();
            return;
        }
        
        if(this.drag.mode==='wall') {
            const t=this.drag.temp;
            if(Math.hypot(t.x1-t.x2, t.y1-t.y2) > 10) {
                this.scene.walls.push({ id: 'w_'+Date.now(), x1:t.x1, y1:t.y1, x2:t.x2, y2:t.y2, width: this.toolSettings.wallWidth, color: this.drawColor, z: 5, texture: t.texture, tilesPerAxis: t.tilesPerAxis, curve: 0, invisible: t.invisible });
                this.renderer.fowDirty = true;
                this.renderer.mapDirty = true;
                this.sync();
            }
        }
        else if(this.drag.mode==='column') {
                if(this.drag.temp.radius > 5) {
                    this.scene.columns.push({ ...this.drag.temp, id: 'c_'+Date.now(), z: 10 }); 
                    this.renderer.fowDirty = true;
                    this.renderer.mapDirty = true;
                    this.sync();
                }
        }
        else if(this.drag.mode === 'brush') {
            this.scene.drawings.push(JSON.parse(JSON.stringify(this.drag.temp)));
            this.renderer.drawingsDirty = true;
            this.sync();
        }
        else if(['grid_paint','rect_paint','circle_paint'].includes(this.drag.mode)) { 
            this.scene.drawings.push(JSON.parse(JSON.stringify(this.drag.temp))); 
            this.renderer.drawingsDirty = true;
            this.sync(); 
        }
        else if(['move_player','obj','light','resize','rotate','wall_move','wall_drag','column_move','resize_column'].includes(this.drag.mode)) this.flushSync();
        
        this.drag.mode = null; this.drag.temp = null;
        this.renderer.setToolSettings(this.toolSettings, this.drawColor, this.brushTexture, this.tilesPerAxis);
        this.renderer.setDragState(this.drag, this.selObjId);
        this.renderer.requestRender(); 
    },

    onWheel(e) {
        if(e.target.closest('.panel-content') || e.target.closest('.asset-grid')) return;
        if(!this.isGM || !this.renderer) return;
        e.preventDefault();
        const scaleFactor = e.deltaY > 0 ? 0.9 : 1.1;
        const oldScale = this.scene.view.scale; 
        const newScale = Math.min(4, Math.max(0.1, oldScale * scaleFactor));
        const rect = this.renderer.pixiApp.view.getBoundingClientRect();
        const mouseX = e.clientX - rect.left; const mouseY = e.clientY - rect.top;
        const worldX = (mouseX - this.scene.view.x) / oldScale; const worldY = (mouseY - this.scene.view.y) / oldScale;
        this.scene.view.x = mouseX - worldX * newScale; this.scene.view.y = mouseY - worldY * newScale;
        this.scene.view.scale = newScale;
        this.renderer.requestRender();
    },

    onKeyDown(e) {
        if(!this.isGM) return;
        // STRG+C / STRG+V zum Kopieren von Objekten
        if((e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'C')) {
            if(this.selectedObj) {
                this._clipboard = JSON.parse(JSON.stringify(this.selectedObj));
                e.preventDefault();
            }
            return;
        }
        if((e.ctrlKey || e.metaKey) && (e.key === 'v' || e.key === 'V')) {
            if(this._clipboard) {
                const c = this._clipboard;
                const nid = Date.now();
                const copy = {...c, id: nid, x: c.x + 50, y: c.y + 50};
                if(c.x1 !== undefined) { copy.x1 = c.x1 + 50; copy.x2 = c.x2 + 50; copy.y1 = c.y1 + 50; copy.y2 = c.y2 + 50; }
                if(this.selectedObjIsWall || (c.x1 !== undefined)) {
                    this.scene.walls.push(copy);
                    this.selectedObjIsWall = true; this.selectedObjIsColumn = false; this.selectedObjIsLight = false;
                } else if(this.selectedObjIsColumn || (c.vertices !== undefined)) {
                    this.scene.columns.push(copy);
                    this.selectedObjIsColumn = true; this.selectedObjIsWall = false; this.selectedObjIsLight = false;
                } else if(this.selectedObjIsLight || (c.radius !== undefined && c.color)) {
                    this.scene.lights.push(copy);
                    this.selectedObjIsLight = true; this.selectedObjIsWall = false; this.selectedObjIsColumn = false;
                } else {
                    this.scene.objects.push(copy);
                    this.selectedObjIsWall = false; this.selectedObjIsColumn = false; this.selectedObjIsLight = false;
                }
                this.selObjId = nid;
                if(this.renderer) this.renderer.selectedObjId = nid;
                this.sync();
                if(this.renderer) { this.renderer.mapDirty = true; this.renderer.requestRender(); }
                e.preventDefault();
            }
            return;
        }
        if(e.key === 'Escape') {
            if(this.showColorPicker) { this.showColorPicker=false; return; }
            this.setTool('select'); this.brushTexture = null; this.selObjId = null; 
            if(this.renderer) this.renderer.requestRender();
            return;
        }
        if(e.key.startsWith('Arrow') && this.selectedObj) {
            e.preventDefault();
            const step = e.shiftKey ? 10 : 1;
            const o = this.selectedObj;

            if (this.selectedObjIsWall) {
                // Wände haben kein x/y, nur Endpunkte x1/y1/x2/y2 – verschiebe diese direkt
                const dx = e.key === 'ArrowLeft' ? -step : (e.key === 'ArrowRight' ? step : 0);
                const dy = e.key === 'ArrowUp' ? -step : (e.key === 'ArrowDown' ? step : 0);
                o.x1 += dx; o.y1 += dy; o.x2 += dx; o.y2 += dy;
                this.renderer.fowDirty = true;
                this.renderer.mapDirty = true;
            } else {
                if(e.key === 'ArrowLeft') o.x -= step;
                if(e.key === 'ArrowRight') o.x += step;
                if(e.key === 'ArrowUp') o.y -= step;
                if(e.key === 'ArrowDown') o.y += step;
                if(this.selectedObjIsColumn) {
                    this.renderer.fowDirty = true;
                    this.renderer.mapDirty = true;
                }
                if(this.selectedObjIsLight) this.renderer.lightsDirty = true;
            }

            this.sync();
            this.renderer.requestRender();
            return;
        }

        if((e.key === 'Delete' || e.key === 'Backspace') && this.selectedObj) {
            if (this.scene.background_locked) {
                    if (this.selectedObj.z !== undefined && this.selectedObj.z < 0) return; 
            }
            this.deleteSelected();
            // Explicitly force a render update to remove the selection overlay
            if(this.renderer) {
                this.renderer._renderDirty = true;
                this.renderer.requestRender();
            }
        }
    },

    onAssetDragStart(a, e) { e.dataTransfer.setData("text/plain", a.url); e.dataTransfer.dropEffect = "copy"; },
    
    dropFile(e) { 
        e.preventDefault(); 
        if(this.scene.objects_locked) return;
        if(!this.isGM || this.tab !== 'tools' || !this.renderer) return; 
        
        const pos = this.renderer.getWorldPos(e);
        const assetUrl = e.dataTransfer.getData("text/plain");
        this.setTool('select');

        if(assetUrl && assetUrl.startsWith('/assets/')) {
                this.addObjectAt(pos, assetUrl, 'image');
                return;
        }

        const file = e.dataTransfer.files[0]; if(!file) return;
        const reader = new FileReader(); 
        reader.onload = (evt) => {
            socket.emit('upload_asset', {name: file.name, data: evt.target.result, path: this.currentAssetPath}, (res) => {
                    if(res && res.url) {
                        if(e.target.closest('.drop-zone')) return;
                        if(['brush', 'grid_paint', 'rect_paint', 'circle_paint', 'wall'].includes(this.tool)) this.brushTexture = res.url;
                        else {
                            this.addObjectAt(pos, res.url, res.type);
                        }
                    }
            });
        };
        reader.readAsDataURL(file);
    },
    
    startDragCorner(e, idx) { 
        this.cornerDragIdx = idx; 
        window.addEventListener('mousemove', this.onCornerMove); 
        window.addEventListener('mouseup', this.stopCornerDrag); 
    },
    
    onCornerMove(e) { 
        if(this.cornerDragIdx === -1) return; 
        
        const rect = this.$refs.calibImg.getBoundingClientRect(); 
        let mouseX = e.clientX - rect.left;
        let mouseY = e.clientY - rect.top;
        
        let imgX = (mouseX / rect.width) * this.imgW;
        let imgY = (mouseY / rect.height) * this.imgH;
        
        if (imgX < 0) imgX = 0;
        if (imgX > this.camW) imgX = this.camW;
        if (imgY < 0) imgY = 0;
        if (imgY > this.camH) imgY = this.camH;

        this.tempCorners[this.cornerDragIdx] = [imgX, imgY]; 
    },
    
    stopCornerDrag() { 
        this.cornerDragIdx = -1; 
        window.removeEventListener('mousemove', this.onCornerMove); 
        window.removeEventListener('mouseup', this.stopCornerDrag); 
        this.camParams.corners = JSON.parse(JSON.stringify(this.tempCorners));
        this.updateCamParams(); 
    },
    onContextMenu(e) { e.preventDefault(); },
};