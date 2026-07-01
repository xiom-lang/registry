"""AXIOM Package Registry Server -- stores and serves AXIOM packages."""
import http.server
import json
import os
import shutil

PACKAGES_DIR = os.path.join(os.path.dirname(__file__), 'packages')
INDEX_FILE = os.path.join(os.path.dirname(__file__), 'index.json')
PORT = 8080

def load_index():
    if os.path.exists(INDEX_FILE):
        with open(INDEX_FILE) as f:
            return json.load(f)
    return {"packages": {}}

def save_index(index):
    with open(INDEX_FILE, 'w') as f:
        json.dump(index, f, indent=2)

class RegistryHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=PACKAGES_DIR, **kwargs)

    def do_GET(self):
        if self.path == '/':
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            index = load_index()
            self.wfile.write(json.dumps(index, indent=2).encode())
        elif self.path == '/index.json':
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            index = load_index()
            self.wfile.write(json.dumps(index, indent=2).encode())
        else:
            super().do_GET()

    def do_POST(self):
        if self.path == '/publish':
            content_length = int(self.headers['Content-Length'])
            data = json.loads(self.rfile.read(content_length))

            name = data.get('name')
            version = data.get('version')

            if not name or not version:
                self.send_response(400)
                self.end_headers()
                return

            # Store package files (simplified: just metadata)
            index = load_index()
            key = f"{name}@{version}"
            index['packages'][key] = {
                'name': name,
                'version': version,
                'description': data.get('description', ''),
                'author': data.get('author', ''),
                'files': data.get('files', []),
            }
            save_index(index)

            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({"status": "published", "package": key}).encode())
        else:
            self.send_response(404)
            self.end_headers()

if __name__ == '__main__':
    os.makedirs(PACKAGES_DIR, exist_ok=True)
    if not os.path.exists(INDEX_FILE):
        save_index({"packages": {}})
    print(f'AXIOM Package Registry at http://localhost:{PORT}')
    print('GET  /index.json  — list all packages')
    print('POST /publish     — publish a package')
    server = http.server.HTTPServer(('', PORT), RegistryHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\nStopped.')
