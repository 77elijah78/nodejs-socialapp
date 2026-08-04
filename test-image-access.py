import urllib.request, json, base64

png = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==")
url = "http://localhost:3000/api/v1"

# Login
req = urllib.request.Request(url + "/auth/login",
    data=json.dumps({"email": "alice@example.com", "password": "Password123!"}).encode(),
    headers={"Content-Type": "application/json"}, method="POST")
resp = urllib.request.urlopen(req, timeout=10)
token = json.loads(resp.read())["data"]["accessToken"]

# Upload image
boundary = "----Test123"
body = (f"--{boundary}\r\n".encode()
    + b'Content-Disposition: form-data; name="file"; filename="test.png"\r\n'
    + b"Content-Type: image/png\r\n\r\n"
    + png
    + f"\r\n--{boundary}--\r\n".encode())
req = urllib.request.Request(url + "/media/upload", data=body,
    headers={"Authorization": f"Bearer {token}", "Content-Type": f"multipart/form-data; boundary={boundary}"}, method="POST")
resp = urllib.request.urlopen(req, timeout=10)
media_url = json.loads(resp.read())["data"]["url"]
print(f"Media URL: {media_url}")

# Check if image is accessible directly
try:
    req = urllib.request.Request(media_url)
    resp = urllib.request.urlopen(req, timeout=10)
    print(f"Image accessible: {resp.status} ({len(resp.read())} bytes)")
except Exception as e:
    print(f"Image NOT accessible: {e}")

# Create story
req = urllib.request.Request(url + "/posts/stories",
    data=json.dumps({"mediaUrl": media_url, "mediaType": "image", "caption": "Test"}).encode(),
    headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"}, method="POST")
resp = urllib.request.urlopen(req, timeout=10)
data = json.loads(resp.read())
print(f"Story created: {data['success']}")

# Get stories
req = urllib.request.Request(url + "/posts/stories", headers={"Authorization": f"Bearer {token}"}, method="GET")
resp = urllib.request.urlopen(req, timeout=10)
data = json.loads(resp.read())
if data["data"]:
    story = data["data"][0]
    print(f"Story mediaUrl: {story['mediaUrl']}")
    # Check image access via 192.168.1.3
    try:
        req = urllib.request.Request(story["mediaUrl"])
        resp = urllib.request.urlopen(req, timeout=10)
        print(f"Story image accessible via 192.168.1.3: {resp.status} ({len(resp.read())} bytes)")
    except Exception as e:
        print(f"Story image NOT accessible: {e}")
