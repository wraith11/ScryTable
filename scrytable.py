import os

# Versuch, Logging stummzuschalten (Fehlertolerant)
try:
    os.environ["OPENCV_LOG_LEVEL"] = "OFF"
except:
    pass

import asyncio
import socketio
from aiohttp import web
import cv2
import numpy as np
import json
import threading
import time
import math
import uuid
import base64
import webbrowser
import socket

import argparse
print("ScryTable Server starting...")

# --- KONFIGURATION ---
DEFAULT_HOST = "0.0.0.0"
DEFAULT_PORT = 8080
HOST = DEFAULT_HOST
HTTP_PORT = DEFAULT_PORT
SETTINGS_FILE = "config.json"
MAPS_DIR = "maps"
ASSET_DIR = "assets"
MEDIA_DIR = "media"
MAX_BUFFER_SIZE = 100 * 1024 * 1024

if not os.path.exists(ASSET_DIR): os.makedirs(ASSET_DIR)
if not os.path.exists(MAPS_DIR): os.makedirs(MAPS_DIR)
if not os.path.exists(MEDIA_DIR): os.makedirs(MEDIA_DIR)

# --- GLOBALS & LOCKS ---
current_frame_jpeg = None
camera_lock = threading.Lock()
camera_reset_requested = False
camera_settings_requested = False
camera_change_requested = False 
current_cam_res = {'w': 1280, 'h': 720}

# --- SOCKET.IO SETUP ---
sio = socketio.AsyncServer(async_mode='aiohttp', cors_allowed_origins='*', max_http_buffer_size=MAX_BUFFER_SIZE)
app = web.Application()

# --- MIDDLEWARE: Kein Caching der statischen Dateien (JS/CSS) ---
# Verhindert, dass Browser veraltete Module (renderer.js, core-methods.js ...) liefern,
# da die ES-Modul-Imports keine Cache-Busting-Version haben.
@web.middleware
async def no_cache_middleware(request, handler):
    response = await handler(request)
    if request.path.startswith('/js/') or request.path.startswith('/css/') or request.path.endswith('.js'):
        response.headers['Cache-Control'] = 'no-cache, no-store, must-revalidate'
        response.headers['Pragma'] = 'no-cache'
        response.headers['Expires'] = '0'
    return response

app.middlewares.append(no_cache_middleware)
sio.attach(app)

# --- STATE ---
state = {
    'cam_params': {
        'camera_index': 0,
        'threshold': 200, 
        'min_area': 15, 'max_area': 5000, 
        'corners': [[0, 0], [1280, 0], [1280, 720], [0, 720]], 
        'flip_x': False, 'flip_y': False, 
        'smoothing': 0.2,
        'hotspot_compensation': 0.0,
        'merge_distance': 25,
        'parallax_strength': 0.0,
        'cam_pos_x': 0.5, 
        'cam_pos_y': 0.5
    },
    'scene': {
        'grid_size': 50, 'show_grid': True, 'background_color': '#222222',
        'background_image': { 'url': None, 'x': 0, 'y': 0, 'scale': 1.0, 'repeat': False, 'opacity': 1.0 },
        'fow_active': False, 'fow_mode': 'temporary',
        'objects_locked': False, 
        'show_blob_ids': True,
        'background_locked': False, 'show_light_icons': True,
        'drawings': [], 'walls': [], 'columns': [], 'lights': [], 'objects': [], 'tokens': {}, 'fow_shapes': [], 
        'fow_visited': [],
        'view': {'x': 0, 'y': 0, 'scale': 1.0},
        'player_view': { 'x': 2000, 'y': 1500, 'width_cells': 30, 'aspect': 1.777 },
        'player_view_blackout': True,
        'blackout_config': {
            'mode': 'full',
            'sync': True,
            'screens': [
                {'url': None, 'type': 'image', 'loop': True, 'flipped': False},
                {'url': None, 'type': 'image', 'loop': True, 'flipped': False},
                {'url': None, 'type': 'image', 'loop': True, 'flipped': True},
                {'url': None, 'type': 'image', 'loop': True, 'flipped': True}
            ]
        },
        'tracking_paused': False, 'time_of_day': 'day',
        'show_player_frame': True,
        'lights_active': True 
    }
}

# --- HELPER ---
def load_server_config():
    """Liest optional host/port aus config.json (Sektion 'server'). CLI-Arg übersteuert das."""
    global HOST, HTTP_PORT
    try:
        if os.path.exists(SETTINGS_FILE):
            with open(SETTINGS_FILE, 'r') as f:
                cfg = json.load(f)
                server = cfg.get('server', {})
                if server.get('host'): HOST = server['host']
                if server.get('port'): HTTP_PORT = int(server['port'])
    except Exception as e:
        print(f"Server config load failed: {e}")

def save_state_to_disk():
    try:
        # Vorhandene 'server'-Sektion bewahren (manuelle host/port-Einstellung nicht überschreiben)
        server_cfg = {}
        try:
            if os.path.exists(SETTINGS_FILE):
                with open(SETTINGS_FILE, 'r') as f:
                    server_cfg = json.load(f).get('server', {})
        except: pass
        if not server_cfg:
            server_cfg = {'host': HOST, 'port': HTTP_PORT}

        temp_cam = {}
        for k, v in state['cam_params'].items():
            if isinstance(v, (np.integer, int)): temp_cam[k] = int(v)
            elif isinstance(v, (np.floating, float)): temp_cam[k] = float(v)
            elif isinstance(v, list): temp_cam[k] = v 
            else: temp_cam[k] = v

        temp = {
            'server': server_cfg,
            'cam_params': temp_cam,
            'scene_config': {
                'view': state['scene']['view'],
                'player_view': state['scene']['player_view'],
                'show_blob_ids': state['scene']['show_blob_ids'],
                'grid_size': state['scene']['grid_size'],
                'show_grid': state['scene']['show_grid'],
                'show_player_frame': state['scene'].get('show_player_frame', True),
                'time_of_day': state['scene'].get('time_of_day', 'day'),
                'token_size_default': state['scene'].get('token_size_default', 45),
                'ring_thickness': state['scene'].get('ring_thickness', 10),
                'token_name_size': state['scene'].get('token_name_size', 12),
                'token_color_default': state['scene'].get('token_color_default', '#aaaaaa'),
                'blackout_config': state['scene'].get('blackout_config')
            }
        }
        with open(SETTINGS_FILE, 'w') as f:
            json.dump(temp, f, indent=2)
    except Exception as e:
        print(f"Auto-save failed: {e}")

def load_state_from_disk():
    if os.path.exists(SETTINGS_FILE):
        try:
            with open(SETTINGS_FILE, 'r') as f:
                saved = json.load(f)
                if 'cam_params' in saved: state['cam_params'].update(saved['cam_params'])
                if 'scene_config' in saved:
                    for k, v in saved['scene_config'].items():
                        if k in state['scene']: state['scene'][k] = v
            print("System settings loaded.")
        except Exception as e:
            print(f"Load failed: {e}")

def safe_asset_path(subdir=''):
    """Bereinigt einen Unterordner-Pfad und verhindert ein Entkommen aus dem Assets-Root."""
    subdir = subdir.replace('..', '').strip('/\\')
    base = os.path.abspath(ASSET_DIR)
    target = os.path.normpath(os.path.join(base, subdir))
    if not (target == base or target.startswith(base + os.sep)):
        return base, ''
    return target, subdir

def get_dir_content(subdir=''):
    base_abs = os.path.abspath(ASSET_DIR)
    target_path, subdir = safe_asset_path(subdir)
    items = []
    if os.path.exists(target_path) and os.path.isdir(target_path):
        for f in os.listdir(target_path):
            if f.startswith('.'): continue
            full_p = os.path.join(target_path, f)
            rel_p = os.path.join(subdir, f).replace("\\", "/")
            if os.path.isdir(full_p): items.append({'name': f, 'type': 'folder', 'path': rel_p})
            else:
                ext = f.split('.')[-1].lower()
                if ext in ['jpg', 'jpeg', 'png', 'gif', 'webp']: items.append({'name': f, 'type': 'image', 'url': f'/assets/{rel_p}'})
                elif ext in ['mp4', 'webm']: items.append({'name': f, 'type': 'video', 'url': f'/assets/{rel_p}'})
    items.sort(key=lambda x: (0 if x['type'] == 'folder' else 1, x['name'].lower()))
    return items

def get_media_content():
    items = []
    if os.path.exists(MEDIA_DIR):
        for f in os.listdir(MEDIA_DIR):
            if f.startswith('.'): continue
            ext = f.split('.')[-1].lower()
            if ext in ['jpg', 'jpeg', 'png', 'gif', 'webp']: 
                items.append({'name': f, 'type': 'image', 'url': f'/media/{f}'})
            elif ext in ['mp4', 'webm']: 
                items.append({'name': f, 'type': 'video', 'url': f'/media/{f}'})
    items.sort(key=lambda x: x['name'].lower())
    return items

def get_map_list():
    maps = []
    if os.path.exists(MAPS_DIR):
        for f in os.listdir(MAPS_DIR):
            if f.endswith('.json'):
                maps.append(f)
    maps.sort()
    return maps

def get_local_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except:
        return "localhost"

def list_available_cameras():
    available = []
    for i in range(4): 
        try:
            cap = cv2.VideoCapture(i, cv2.CAP_DSHOW)
            if not cap.isOpened(): cap = cv2.VideoCapture(i)
            if cap.isOpened():
                available.append(i)
                cap.release()
        except: pass
    return available

# --- TRACKING LOGIK ---
class BlobTracker:
    def __init__(self):
        self.tracks = {}          
        self.ANCHOR_RADIUS = 0.15 
        self.GHOST_TIMEOUT = 5.0 
        self.MIN_LIFETIME = 0.2

    def get_next_free_id(self):
        used_ids = set()
        for t_id in self.tracks:
            try: used_ids.add(int(t_id))
            except: pass
        candidate = 1
        while candidate in used_ids: candidate += 1
        return str(candidate)

    def update(self, detected_points, smoothing=0.2):
        now = time.time()
        all_track_ids = list(self.tracks.keys())
        assigned_tracks = set()
        assigned_points = set()

        # --- Original-Greedy (bewährte 2025-Logik) ---
        # Phase 1: Anker – Alle (Track, Punkt, Distanz)-Paare global nach Distanz sortieren
        # und der Reihe nach zuordnen, wenn der Punkt innerhalb ANCHOR_RADIUS liegt.
        all_matches = []
        for t_id in all_track_ids:
            track = self.tracks[t_id]
            for i, pt in enumerate(detected_points):
                dist = math.hypot(track['x'] - pt['x'], track['y'] - pt['y'])
                all_matches.append((t_id, i, dist))
        all_matches.sort(key=lambda x: x[2])

        # Phase 1: Anker
        for t_id, p_idx, dist in all_matches:
            if t_id in assigned_tracks or p_idx in assigned_points: continue
            if dist < self.ANCHOR_RADIUS:
                self._update_track(t_id, detected_points[p_idx], now, smoothing)
                assigned_tracks.add(t_id)
                assigned_points.add(p_idx)

        # Phase 2: Teleport
        remaining_ghosts = [tid for tid in all_track_ids if tid not in assigned_tracks]
        remaining_points = [i for i in range(len(detected_points)) if i not in assigned_points]

        if remaining_ghosts and remaining_points:
            remaining_ghosts.sort(key=lambda gid: self.tracks[gid]['last_seen'])
            teleport_matches = []
            for gid in remaining_ghosts:
                g = self.tracks[gid]
                for p_idx in remaining_points:
                    pt = detected_points[p_idx]
                    dist = math.hypot(g['x'] - pt['x'], g['y'] - pt['y'])
                    teleport_matches.append((gid, p_idx, dist))
            teleport_matches.sort(key=lambda x: x[2])

            for gid, p_idx, dist in teleport_matches:
                if gid in assigned_tracks or p_idx in assigned_points: continue
                self._update_track(gid, detected_points[p_idx], now, smoothing=0.0)
                assigned_tracks.add(gid)
                assigned_points.add(p_idx)

        # Phase 3: Cleanup & New
        to_delete = []
        lost_ids = []
        for t_id in all_track_ids:
            if t_id not in assigned_tracks:
                self.tracks[t_id]['visible'] = False
                lost_ids.append(t_id)
                if now - self.tracks[t_id]['last_seen'] > self.GHOST_TIMEOUT:
                    to_delete.append(t_id)
        for t_id in to_delete: del self.tracks[t_id]

        new_ids = []
        for i in range(len(detected_points)):
            if i not in assigned_points:
                nid = self.get_next_free_id()
                self.tracks[nid] = {
                    'x': detected_points[i]['x'], 'y': detected_points[i]['y'], 
                    'last_seen': now, 'creation_time': now, 'visible': True
                }
                new_ids.append(nid)

        export_blobs = {}
        valid_new_ids = []
        for t_id, trk in self.tracks.items():
            if now - trk['creation_time'] >= self.MIN_LIFETIME:
                if trk['visible']:
                    export_blobs[t_id] = {'x': trk['x'], 'y': trk['y'], 'lost_frames': 0}
                    if t_id in new_ids: valid_new_ids.append(t_id)

        return export_blobs, valid_new_ids, lost_ids

    def _update_track(self, t_id, pt, now, smoothing):
        track = self.tracks[t_id]
        if not track['visible']: alpha = 1.0 
        else: alpha = 1.0 - max(0.0, min(0.99, smoothing))
        track['x'] = track['x'] * (1-alpha) + pt['x'] * alpha
        track['y'] = track['y'] * (1-alpha) + pt['y'] * alpha
        track['last_seen'] = now
        track['visible'] = True

tracker = BlobTracker()

# --- ROUTES ---
routes = web.RouteTableDef()

@routes.get('/')
async def index(request): return web.FileResponse('./index.html')

@routes.get('/video_feed')
async def video_feed(request):
    boundary = "frame"
    response = web.StreamResponse(status=200, reason='OK', headers={'Content-Type': 'multipart/x-mixed-replace;boundary={}'.format(boundary)})
    await response.prepare(request)
    while True:
        frame_data = None
        with camera_lock:
            if current_frame_jpeg is not None: frame_data = current_frame_jpeg
        if frame_data:
            try:
                await response.write(f'--{boundary}\r\n'.encode('utf-8'))
                await response.write(b'Content-Type: image/jpeg\r\n\r\n')
                await response.write(frame_data)
                await response.write(b'\r\n')
                await asyncio.sleep(0.05)
            except: break
        else: await asyncio.sleep(0.1)
    return response

app.add_routes(routes)
app.router.add_static('/assets', path=os.path.abspath(ASSET_DIR))
app.router.add_static('/media', path=os.path.abspath(MEDIA_DIR))
app.router.add_static('/css', path=os.path.abspath('./css'))
app.router.add_static('/js', path=os.path.abspath('./js'))

# --- SOCKET EVENTS ---
@sio.event
async def connect(sid, environ):
    await sio.emit('init', state['scene'], to=sid)
    await sio.emit('cam_params_sync', state['cam_params'], to=sid)
    await sio.emit('camera_resolution', current_cam_res, to=sid)
    await sio.emit('asset_list_update', {'path': '', 'items': get_dir_content('')}, to=sid)
    await sio.emit('media_list_update', get_media_content(), to=sid)
    await sio.emit('map_list_update', get_map_list(), to=sid)
    await sio.emit('server_info', {'ip': get_local_ip(), 'port': HTTP_PORT}, to=sid)

@sio.event
async def request_assets(sid, data):
    path = data.get('path', '')
    await sio.emit('asset_list_update', {'path': path, 'items': get_dir_content(path)}, to=sid)

@sio.event
async def request_media(sid):
    await sio.emit('media_list_update', get_media_content(), to=sid)

@sio.event
async def create_folder(sid, data):
    path = data.get('path', '')
    name = "".join([c for c in data.get('name','') if c.isalnum() or c in (' ', '_', '-')])
    full_path, _ = safe_asset_path(os.path.join(path, name))
    try: 
        os.makedirs(full_path, exist_ok=True)
        await sio.emit('asset_list_update', {'path': path, 'items': get_dir_content(path)}, to=sid)
    except: pass

@sio.event
async def update_scene(sid, data):
    config_changed = False
    changed_keys = set()
    
    if 'player_view' in data and isinstance(data['player_view'], dict):
        new_pv = data['player_view']
        curr_pv = state['scene']['player_view']
        for k, v in new_pv.items():
            if curr_pv.get(k) != v:
                curr_pv[k] = v
                config_changed = True
                changed_keys.add('player_view')
    
    simple_config_keys = ['show_blob_ids', 'show_player_frame', 'grid_size', 'show_grid', 'time_of_day']
    for key in simple_config_keys:
        if key in data and state['scene'].get(key) != data[key]:
            state['scene'][key] = data[key]
            config_changed = True
            changed_keys.add(key)
    
    if 'blackout_config' in data:
        if state['scene'].get('blackout_config') != data['blackout_config']:
            state['scene']['blackout_config'] = data['blackout_config']
            config_changed = True
            changed_keys.add('blackout_config')

    if 'view' in data and isinstance(data['view'], dict):
        new_view = data['view']
        curr_view = state['scene']['view']
        for k, v in new_view.items():
            if curr_view.get(k) != v:
                curr_view[k] = v
                config_changed = True
                changed_keys.add('view')

    for key, value in data.items():
        if key in ['player_view', 'view', 'blackout_config'] or key in simple_config_keys: continue 
        
        if key == 'background_image' and isinstance(value, dict):
            # Komplett ersetzen (kein .update), damit url:null den Hintergrund zuverlässig leert
            if state['scene']['background_image'] != value:
                state['scene']['background_image'] = dict(value)
                changed_keys.add('background_image')
        elif key == 'fow_visited' and isinstance(value, list):
             if state['scene']['fow_visited'] != value:
                 state['scene']['fow_visited'] = value
                 changed_keys.add('fow_visited')
        else:
            if state['scene'].get(key) != value:
                state['scene'][key] = value
                changed_keys.add(key)

    if config_changed: save_state_to_disk()
    if changed_keys:
        delta = {k: data[k] for k in changed_keys}
        await sio.emit('update_scene', delta, skip_sid=sid)

@sio.event
async def fow_visited_delta(sid, data):
    """A2: Neue fow_visited-Punkte anhängen und nur das Delta broadcasten."""
    points = data.get('points', [])
    if not isinstance(points, list) or len(points) == 0: return
    scene = state['scene']
    if 'fow_visited' not in scene: scene['fow_visited'] = []
    scene['fow_visited'].extend(points)
    await sio.emit('fow_visited_delta', {'points': points}, skip_sid=sid)

@sio.event
async def fow_visited_full(sid, data):
    """A2: Vollständigen fow_visited-Stand austauschen (periodischer Abgleich gegen Desync)."""
    points = data.get('points', [])
    if not isinstance(points, list): return
    state['scene']['fow_visited'] = points
    await sio.emit('fow_visited_full', {'points': points}, skip_sid=sid)

@sio.event
async def update_cam_params(sid, data):
    for k, v in data.items():
        state['cam_params'][k] = v
    save_state_to_disk()
    # Kamera-Parameter nur an den Sender (GM) – Player brauchen sie nicht
    await sio.emit('cam_params_sync', state['cam_params'], to=sid)

@sio.event
async def change_camera(sid, index):
    global camera_change_requested
    state['cam_params']['camera_index'] = int(index)
    save_state_to_disk()
    camera_change_requested = True
    await sio.emit('cam_params_sync', state['cam_params'])

@sio.event
async def refresh_cameras(sid):
    cams = list_available_cameras()
    await sio.emit('available_cameras', cams, to=sid)

@sio.event
async def reset_camera(sid):
    global camera_reset_requested
    state['cam_params']['threshold'] = 200
    state['cam_params']['parallax_strength'] = 0.0
    state['cam_params']['merge_distance'] = 25
    camera_reset_requested = True
    save_state_to_disk()
    await sio.emit('cam_params_sync', state['cam_params'])

@sio.event
async def open_camera_settings(sid):
    global camera_settings_requested
    camera_settings_requested = True

@sio.event
async def save_settings(sid):
    save_state_to_disk()

@sio.event
async def save_map(sid, data):
    # data kann entweder ein String (alter Aufruf) oder ein Objekt {filename, view} sein
    if isinstance(data, dict):
        filename = data.get('filename', '')
        new_view = data.get('view')
        if isinstance(new_view, dict):
            for k, v in new_view.items():
                state['scene']['view'][k] = v
    else:
        filename = data or ''
    # Bestehende .json-Endung entfernen, dann neu anhängen (kein Doppel-".json")
    name = filename or ""
    if name.lower().endswith('.json'):
        name = name[:-5]
    # Sicheres Filtern – Punkt für evtl. vorhandene Endungen erlauben, Endung wird neu gesetzt
    base_name = "".join([c for c in name if c.isalnum() or c in (' ', '_', '-', '.')])
    safe_name = base_name + ".json"
    full_path = os.path.join(MAPS_DIR, safe_name)
    try:
        map_data = state['scene'].copy()
        map_data['tracking_paused'] = False
        with open(full_path, 'w') as f: json.dump(map_data, f, indent=2)
        await sio.emit('map_list_update', get_map_list())
        return {'success': True}
    except Exception as e: return {'error': str(e)}

@sio.event
async def load_map(sid, filename):
    full_path = os.path.join(MAPS_DIR, filename)
    if os.path.exists(full_path):
        try:
            with open(full_path, 'r') as f: map_data = json.load(f)
            current_blackout = state['scene']['player_view_blackout']
            state['scene'] = map_data
            
            # BUGFIX: Auto-enable blackout on map load
            state['scene']['player_view_blackout'] = True
            
            if 'fow_visited' not in state['scene']: state['scene']['fow_visited'] = []
            if 'show_player_frame' not in state['scene']: state['scene']['show_player_frame'] = True
            
            if 'blackout_config' not in state['scene']: 
                state['scene']['blackout_config'] = {
                    'mode': 'full', 'sync': True,
                    'screens': [{'url':None,'type':'image','loop':True,'flipped':False} for _ in range(4)]
                }
            await sio.emit('init', state['scene'])
            return {'success': True}
        except Exception as e: return {'error': str(e)}
    return {'error': 'File not found'}

@sio.event
async def new_map(sid):
    # Szene zurücksetzen (leere Karte) und init an alle Clients senden.
    # Dadurch ersetzt jeder Client seine Scene frisch und baut die Map neu (kein Hintergrund).
    sc = state['scene']
    sc['objects'] = []
    sc['walls'] = []
    sc['columns'] = []
    sc['lights'] = []
    sc['drawings'] = []
    sc['fow_shapes'] = []
    sc['fow_visited'] = []
    sc['tokens'] = {}
    sc['background_image'] = {'url': None, 'x': 0, 'y': 0, 'scale': 1.0, 'repeat': False, 'opacity': 1.0}
    await sio.emit('init', state['scene'])
    return {'success': True}

@sio.event
async def delete_map(sid, filename):
    # Nur Dateinamen im maps-Verzeichnis löschen (Path-Traversal verhindern)
    safe_name = os.path.basename(filename or "")
    full_path = os.path.join(MAPS_DIR, safe_name)
    if safe_name and os.path.exists(full_path) and os.path.isfile(full_path):
        try:
            os.remove(full_path)
            await sio.emit('map_list_update', get_map_list())
            return {'success': True}
        except Exception as e: return {'error': str(e)}
    return {'error': 'File not found'}

@sio.event
async def upload_asset(sid, data):
    try:
        if ',' in data['data']: _, encoded = data['data'].split(",", 1)
        else: encoded = data['data']
        file_bytes = base64.b64decode(encoded)
        path = data.get('path', '')
        target_dir, path = safe_asset_path(path)
        ext = data['name'].split('.')[-1].lower() if '.' in data['name'] else 'png'
        safe_name = f"{uuid.uuid4()}.{ext}"
        if not os.path.exists(target_dir): os.makedirs(target_dir)
        final_path = os.path.join(target_dir, safe_name)
        with open(final_path, "wb") as f: f.write(file_bytes)
        url = f"/assets/{path}/{safe_name}".replace('//', '/')
        if path: url = f"/assets/{path}/{safe_name}"
        else: url = f"/assets/{safe_name}"
        await sio.emit('asset_list_update', {'path': path, 'items': get_dir_content(path)}, to=sid)
        return {'url': url, 'type': 'video' if ext in ['mp4', 'webm'] else 'image'}
    except Exception as e: 
        print(f"Upload error: {e}")
        return {'error': str(e)}

@sio.event
async def toggle_blackout(sid, data):
    state['scene']['player_view_blackout'] = data['active']
    await sio.emit('update_scene', {'player_view_blackout': data['active']}, skip_sid=sid)

# --- CAMERA THREAD ---
def run_cv_loop(loop_ref):
    global current_frame_jpeg, current_cam_res, camera_reset_requested, camera_settings_requested, camera_change_requested
    
    print("CV Thread started.")
    load_state_from_disk()
    
    target_cam_idx = state['cam_params'].get('camera_index', 0)
    cap = None
    
    available = list_available_cameras()
    if target_cam_idx not in available and available:
        print(f"Stored camera {target_cam_idx} unavailable. Using {available[0]}")
        target_cam_idx = available[0]
        state['cam_params']['camera_index'] = target_cam_idx
    
    try:
        cap = cv2.VideoCapture(target_cam_idx, cv2.CAP_DSHOW)
        if not cap.isOpened(): cap = cv2.VideoCapture(target_cam_idx)
        
        if cap.isOpened():
            print(f"Connected to Camera {target_cam_idx}")
            cap.set(cv2.CAP_PROP_FRAME_WIDTH, 1280); cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 720)
            actual_w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
            actual_h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
            current_cam_res = {'w': actual_w, 'h': actual_h}
            asyncio.run_coroutine_threadsafe(sio.emit('camera_resolution', current_cam_res), loop_ref)
        else:
            print(f"Could not connect to Camera {target_cam_idx}")
            cap = None
    except: cap = None
    
    WARPED_SIZE = 1000
    had_active_blobs = False
    
    last_camera_success_time = time.time() if (cap and cap.isOpened()) else 0
    error_log_counter = 0

    cached_gain_map = None
    last_hotspot_val = -1

    # B1: JPEG-Encoding auf ~20 fps drosseln, unabhängig vom (schnelleren) Tracking-Loop
    last_encode_time = 0.0
    ENCODE_INTERVAL = 0.05

    while True:
        loop_start_time = time.time()

        if camera_change_requested:
            if cap: cap.release()
            target_cam_idx = state['cam_params'].get('camera_index', 0)
            print(f"Switching to Camera {target_cam_idx}...")
            cap = cv2.VideoCapture(target_cam_idx, cv2.CAP_DSHOW)
            if not cap.isOpened(): cap = cv2.VideoCapture(target_cam_idx)
            
            if cap.isOpened():
                cap.set(cv2.CAP_PROP_FRAME_WIDTH, 1280); cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 720)
                current_cam_res = {'w': int(cap.get(3)), 'h': int(cap.get(4))}
                last_camera_success_time = time.time()
                asyncio.run_coroutine_threadsafe(sio.emit('camera_resolution', current_cam_res), loop_ref)
            camera_change_requested = False

        if camera_reset_requested and cap:
            cap.release(); time.sleep(1)
            cap = cv2.VideoCapture(target_cam_idx, cv2.CAP_DSHOW)
            if not cap.isOpened(): cap = cv2.VideoCapture(target_cam_idx)
            if cap.isOpened(): 
                cap.set(cv2.CAP_PROP_FRAME_WIDTH, 1280); cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 720)
                last_camera_success_time = time.time()
            camera_reset_requested = False
            
        if camera_settings_requested:
            # Flag in jedem Fall zurücksetzen, auch wenn die Kamera gerade nicht offen ist
            if cap and cap.isOpened():
                cap.set(37, 1)
            camera_settings_requested = False

        frame = None
        if cap and cap.isOpened():
            ret, frame = cap.read()
            if not ret:
                cap.release()
                time.sleep(1)
                cap = cv2.VideoCapture(target_cam_idx, cv2.CAP_DSHOW)
                if not cap.isOpened(): cap = cv2.VideoCapture(target_cam_idx)
                if cap.isOpened(): 
                    cap.set(cv2.CAP_PROP_FRAME_WIDTH, 1280); cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 720)
                    last_camera_success_time = time.time()
                    print(f"Reconnected to Camera {target_cam_idx}")
                continue
        else:
            time.sleep(1)
            cap = cv2.VideoCapture(target_cam_idx, cv2.CAP_DSHOW)
            if not cap.isOpened(): cap = cv2.VideoCapture(target_cam_idx)
            if cap.isOpened(): 
                cap.set(cv2.CAP_PROP_FRAME_WIDTH, 1280); cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 720)
                last_camera_success_time = time.time()
                print(f"Connected to Camera {target_cam_idx}")
                error_log_counter = 0 
            else:
                error_log_counter += 1
                if error_log_counter % 300 == 0: 
                    print(f"Could not connect to Camera {target_cam_idx} (Retrying...)")
            continue

        if frame is None: continue

        params = state['cam_params']
        
        if params.get('flip_x'): frame = cv2.flip(frame, 1)
        if params.get('flip_y'): frame = cv2.flip(frame, 0)
        
        left_view = frame.copy()
        
        # Bugfix: Move the grace period check AFTER left_view is defined.
        # Verzögerung beim Start/Kamerakontakt: Kameras müssen erst die Belichtung einstellen,
        # sonst werden in der ersten Sekunden nicht-existente Blobs erkannt.
        CAMERA_SETTLE_SECONDS = 5.0
        if time.time() - last_camera_success_time < CAMERA_SETTLE_SECONDS:
            blobs = {}
            new_ids = []
            lost_ids = []
            cv2.putText(left_view, "Initializing...", (50, 50), cv2.FONT_HERSHEY_SIMPLEX, 1, (0,0,255), 2)
            h, w = left_view.shape[:2]
            right_view_resized = np.zeros((h, int(WARPED_SIZE * (h/WARPED_SIZE)), 3), dtype=np.uint8)
            
        else:
            corners = params['corners']
            corners_int = np.int32(corners)
            cv2.polylines(left_view, [corners_int], True, (0, 255, 0), 2)
            for i, pt in enumerate(corners_int): 
                cv2.circle(left_view, tuple(pt), 10, (0, 255, 255), -1)
                cv2.putText(left_view, str(i+1), tuple(pt), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0,0,0), 2)

            pts1 = np.array(corners, np.float32)
            pts2 = np.array([[0,0], [WARPED_SIZE,0], [WARPED_SIZE,WARPED_SIZE], [0,WARPED_SIZE]], np.float32)
            M = cv2.getPerspectiveTransform(pts1, pts2)
            warped = cv2.warpPerspective(frame, M, (WARPED_SIZE, WARPED_SIZE))
            gray = cv2.cvtColor(warped, cv2.COLOR_BGR2GRAY)
            
            hotspot_val = params.get('hotspot_compensation', 0.0)
            if hotspot_val > 0.01:
                if cached_gain_map is None or abs(hotspot_val - last_hotspot_val) > 0.001:
                    x = np.linspace(-1, 1, WARPED_SIZE); y = np.linspace(-1, 1, WARPED_SIZE)
                    X, Y = np.meshgrid(x, y)
                    cached_gain_map = 1.0 - (hotspot_val * (1.0 - np.clip(X**2 + Y**2, 0, 1.0)))
                    last_hotspot_val = hotspot_val
                
                gray = np.clip(gray.astype(np.float32) * cached_gain_map, 0, 255).astype(np.uint8)

            blurred = cv2.GaussianBlur(gray, (5,5), 0)
            _, bin_img = cv2.threshold(blurred, params['threshold'], 255, cv2.THRESH_BINARY)
            
            contours, _ = cv2.findContours(bin_img, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            
            raw_points = []
            for c in contours:
                area = cv2.contourArea(c)
                if params['min_area'] < area < params['max_area']:
                    mom = cv2.moments(c)
                    if mom["m00"] != 0:
                        cx = int(mom["m10"]/mom["m00"])
                        cy = int(mom["m01"]/mom["m00"])
                        raw_points.append((cx, cy))
            
            merge_dist = params.get('merge_distance', 25)
            merged_points = []
            used = [False] * len(raw_points)
            for i in range(len(raw_points)):
                if used[i]: continue
                group = [raw_points[i]]
                used[i] = True
                for j in range(i+1, len(raw_points)):
                    if used[j]: continue
                    dist = math.hypot(raw_points[i][0] - raw_points[j][0], raw_points[i][1] - raw_points[j][1])
                    if dist < merge_dist:
                        group.append(raw_points[j])
                        used[j] = True
                avg_x = sum(p[0] for p in group) / len(group)
                avg_y = sum(p[1] for p in group) / len(group)
                merged_points.append({'x': avg_x / WARPED_SIZE, 'y': avg_y / WARPED_SIZE})

            p_str = params.get('parallax_strength', 0.0)
            cam_x = params.get('cam_pos_x', 0.5)
            cam_y = params.get('cam_pos_y', 0.5)
            if abs(p_str) > 0.001:
                for pt in merged_points:
                    dx = cam_x - pt['x']; dy = cam_y - pt['y']
                    pt['x'] += dx * p_str; pt['y'] += dy * p_str

            blobs, new_ids, lost_ids = tracker.update(merged_points, smoothing=params.get('smoothing', 0.2))

            has_content = (len(blobs) > 0 or len(lost_ids) > 0)
            
            if has_content or (not has_content and had_active_blobs):
                 asyncio.run_coroutine_threadsafe(
                    sio.emit('blob_update', {'blobs': blobs, 'new_ids': new_ids, 'lost_ids': lost_ids}), loop_ref
                )
            
            had_active_blobs = has_content

            right_view = cv2.cvtColor(bin_img, cv2.COLOR_GRAY2BGR)
            for bid, b in tracker.tracks.items():
                if b['visible']:
                    px = int(b['x'] * WARPED_SIZE); py = int(b['y'] * WARPED_SIZE)
                    px = max(0, min(WARPED_SIZE, px)); py = max(0, min(WARPED_SIZE, py))
                    age = time.time() - b['creation_time']
                    color = (0, 255, 0) if age > tracker.MIN_LIFETIME else (0, 100, 255)
                    cv2.circle(right_view, (px, py), 15, (0,0,255), 2)
                    cv2.putText(right_view, str(bid), (px+10, py), cv2.FONT_HERSHEY_SIMPLEX, 1, color, 2)
            
            cx_px = int(cam_x * WARPED_SIZE); cy_px = int(cam_y * WARPED_SIZE)
            if 0 <= cx_px <= WARPED_SIZE and 0 <= cy_px <= WARPED_SIZE:
                 cv2.drawMarker(right_view, (cx_px, cy_px), (0, 255, 255), markerType=cv2.MARKER_CROSS, markerSize=20, thickness=2)

            h, w = left_view.shape[:2]
            right_view_resized = cv2.resize(right_view, (int(WARPED_SIZE * (h/WARPED_SIZE)), h))

        # B1: Encodierung nur alle ENCODE_INTERVAL ausführen; Tracking läuft unabhängig weiter
        now_t = time.time()
        if now_t - last_encode_time >= ENCODE_INTERVAL:
            _, buffer = cv2.imencode('.jpg', cv2.hconcat([left_view, right_view_resized]), [int(cv2.IMWRITE_JPEG_QUALITY), 60])
            with camera_lock: current_frame_jpeg = buffer.tobytes()
            last_encode_time = now_t
        
        # 60 FPS Target (0.016s)
        elapsed = time.time() - loop_start_time
        sleep_time = max(0.001, 0.016 - elapsed)
        time.sleep(sleep_time)

async def start_background_tasks(app):
    loop = asyncio.get_running_loop()
    t = threading.Thread(target=run_cv_loop, args=(loop,), daemon=True)
    t.start()
    def open_browser():
        time.sleep(2)
        webbrowser.open(f'http://localhost:{HTTP_PORT}/?view=gm')
    threading.Thread(target=open_browser, daemon=True).start()

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description="ScryTable Server")
    parser.add_argument('--host', default=None, help='Host/IP to bind (default: 0.0.0.0)')
    parser.add_argument('--port', type=int, default=None, help='Port to bind (default: 8080)')
    args = parser.parse_args()

    load_server_config()
    if args.host: HOST = args.host
    if args.port: HTTP_PORT = args.port

    app.on_startup.append(start_background_tasks)
    print(f"Starting server on {HOST}:{HTTP_PORT}...")
    web.run_app(app, host=HOST, port=HTTP_PORT)