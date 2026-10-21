package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"image"
	"image/color"
	"image/png"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type memoryAvatars struct {
	mu     sync.Mutex
	images map[string][]byte
	fail   bool
}

func (m *memoryAvatars) Put(_ context.Context, id string, data []byte) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.fail {
		return errors.New("bucket down")
	}
	m.images[id] = append([]byte(nil), data...)
	return nil
}
func (m *memoryAvatars) Get(_ context.Context, id string) ([]byte, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	data, ok := m.images[id]
	if !ok {
		return nil, errors.New("missing")
	}
	return data, nil
}
func avatarPNG(t *testing.T, width int) []byte {
	t.Helper()
	img := image.NewNRGBA(image.Rect(0, 0, width, 256))
	img.Set(32, 32, color.NRGBA{R: 255, A: 255})
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}
func avatarCode(t *testing.T, handler http.Handler) string {
	t.Helper()
	req := httptest.NewRequest("POST", "/api/avatar-session", nil)
	req.Header.Set("Origin", "http://localhost:5555")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)
	if w.Code != 200 {
		t.Fatalf("create: %d %s", w.Code, w.Body.String())
	}
	var data map[string]string
	if err := json.Unmarshal(w.Body.Bytes(), &data); err != nil {
		t.Fatal(err)
	}
	return data["token"]
}
func TestAvatarUploadLifecycle(t *testing.T) {
	h := newHub(testWorld(), []string{"http://localhost:5555"})
	defer h.close()
	store := &memoryAvatars{images: map[string][]byte{}}
	h.avatars = newAvatarService(store)
	handler := h.handler()
	token := avatarCode(t, handler)
	// Exercise real SDK initialization, discovery and upload over HTTP.
	server := httptest.NewServer(handler)
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	client := mcp.NewClient(&mcp.Implementation{Name: "test-agent", Version: "1"}, nil)
	session, err := client.Connect(ctx, &mcp.StreamableClientTransport{Endpoint: server.URL + "/mcp", DisableStandaloneSSE: true}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer session.Close()
	list, err := session.ListTools(ctx, nil)
	if err != nil || len(list.Tools) != 2 {
		t.Fatalf("tools: %v %v", list, err)
	}
	spec, err := session.CallTool(ctx, &mcp.CallToolParams{Name: "avatar_spec", Arguments: map[string]any{}})
	if err != nil || spec.IsError {
		t.Fatalf("spec: %v %v", spec, err)
	}
	result, err := session.CallTool(ctx, &mcp.CallToolParams{Name: "upload_avatar", Arguments: map[string]any{"uploadCode": token, "pngBase64": base64.StdEncoding.EncodeToString(avatarPNG(t, 384))}})
	if err != nil || result.IsError {
		t.Fatalf("upload: %v %v", result, err)
	}
	// Only the paired browser can poll the upload result.
	req := httptest.NewRequest("GET", "/api/avatar-session", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)
	var status map[string]string
	_ = json.Unmarshal(w.Body.Bytes(), &status)
	id := status["avatarId"]
	if !avatarIDPattern.MatchString(id) {
		t.Fatalf("invalid status: %s", w.Body.String())
	}
	req = httptest.NewRequest("GET", "/api/avatars/"+id, nil)
	w = httptest.NewRecorder()
	handler.ServeHTTP(w, req)
	if w.Code != 200 || w.Header().Get("Content-Type") != "image/png" {
		t.Fatalf("read: %d", w.Code)
	}
	if _, err = png.Decode(w.Body); err != nil {
		t.Fatal(err)
	}
	// A restart retains bucket images, with no shared catalogue endpoint.
	second := newHub(testWorld(), nil)
	defer second.close()
	second.avatars = newAvatarService(store)
	w = httptest.NewRecorder()
	second.handler().ServeHTTP(w, httptest.NewRequest("GET", "/api/avatars/"+id, nil))
	if w.Code != 200 {
		t.Fatal("restart lost image")
	}
	w = httptest.NewRecorder()
	handler.ServeHTTP(w, httptest.NewRequest("GET", "/api/avatars", nil))
	if w.Code != 404 {
		t.Fatal("unexpected public listing")
	}
	result, _, err = h.avatars.upload(ctx, nil, uploadAvatarInput{token, base64.StdEncoding.EncodeToString(avatarPNG(t, 384))})
	if err != nil || !result.IsError {
		t.Fatal("reused upload code accepted")
	}
}
func TestAvatarValidationAndRetry(t *testing.T) {
	s := newAvatarService(&memoryAvatars{images: map[string][]byte{}})
	s.grants["valid"] = &avatarGrant{Expires: time.Now().Add(time.Minute)}
	s.grants["expired"] = &avatarGrant{Expires: time.Now().Add(-time.Minute)}
	good := base64.StdEncoding.EncodeToString(avatarPNG(t, 384))
	for _, in := range []uploadAvatarInput{{"bad", good}, {"expired", good}, {"valid", "not base64"}, {"valid", base64.StdEncoding.EncodeToString(avatarPNG(t, 64))}, {"valid", strings.Repeat("a", base64.StdEncoding.EncodedLen(maxAvatarBytes)+4)}, {"valid", base64.StdEncoding.EncodeToString([]byte("<svg/>"))}} {
		result, _, err := s.upload(context.Background(), nil, in)
		if err != nil || result == nil || !result.IsError {
			t.Fatalf("accepted invalid upload: %s", in.UploadCode)
		}
	}
	// Fully invisible or opaque sheets must not replace a usable avatar.
	for _, opaque := range []bool{false, true} {
		img := image.NewNRGBA(image.Rect(0, 0, 384, 256))
		if opaque {
			for y := 0; y < 256; y++ {
				for x := 0; x < 384; x++ {
					img.Set(x, y, color.NRGBA{R: 255, A: 255})
				}
			}
		}
		var buf bytes.Buffer
		_ = png.Encode(&buf, img)
		result, _, _ := s.upload(context.Background(), nil, uploadAvatarInput{"valid", base64.StdEncoding.EncodeToString(buf.Bytes())})
		if result == nil || !result.IsError {
			t.Fatal("accepted blank or opaque sheet")
		}
	}
	store := s.store.(*memoryAvatars)
	store.fail = true
	result, _, _ := s.upload(context.Background(), nil, uploadAvatarInput{"valid", good})
	if !result.IsError || s.grants["valid"].AvatarID != "" {
		t.Fatal("failed upload consumed code")
	}
	store.fail = false
	result, out, err := s.upload(context.Background(), nil, uploadAvatarInput{"valid", good})
	if err != nil || result != nil || out.AvatarID == "" {
		t.Fatal("retry failed")
	}
}
func TestAvatarOriginAndStorageConfiguration(t *testing.T) {
	h := newHub(testWorld(), []string{"http://localhost:5555"})
	defer h.close()
	handler := h.handler()
	for _, path := range []string{"/api/avatar-session", "/mcp"} {
		req := httptest.NewRequest("POST", path, strings.NewReader(`{}`))
		req.Header.Set("Origin", "https://attacker.example")
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, req)
		if w.Code != 403 {
			t.Fatalf("accepted foreign origin: %s", path)
		}
	}
	req := httptest.NewRequest("POST", "/api/avatar-session", nil)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)
	if w.Code != 403 {
		t.Fatal("missing origin accepted")
	}
	req.Header.Set("Origin", "http://localhost:5555")
	w = httptest.NewRecorder()
	handler.ServeHTTP(w, req)
	if w.Code != 503 {
		t.Fatal("unconfigured storage accepted")
	}
	for _, name := range []string{"ENDPOINT", "NAME", "ACCESS_KEY_ID", "SECRET_ACCESS_KEY", "REGION"} {
		t.Setenv("AVATAR_BUCKET_"+name, "")
	}
	if store, err := avatarStorageFromEnv(); store != nil || err != nil {
		t.Fatal("disabled storage failed")
	}
	t.Setenv("AVATAR_BUCKET_ENDPOINT", "https://example.com")
	if _, err := avatarStorageFromEnv(); err == nil {
		t.Fatal("partial config accepted")
	}
}
func TestBucketAvatarSigningAndRoundTrip(t *testing.T) {
	var saved []byte
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.Header.Get("Authorization"), "AWS4-HMAC-SHA256 ") || r.URL.Path != "/avatars-bucket/avatars/"+strings.Repeat("a", 64)+".png" {
			t.Errorf("unsigned or unexpected request: %s", r.URL.Path)
		}
		switch r.Method {
		case "PUT":
			saved, _ = io.ReadAll(r.Body)
			w.WriteHeader(200)
		case "GET":
			_, _ = w.Write(saved)
		default:
			t.Errorf("unexpected method %s", r.Method)
		}
	}))
	defer server.Close()
	store := &bucketAvatars{bucket: "avatars-bucket", client: s3.New(s3.Options{Region: "auto", BaseEndpoint: aws.String(server.URL), UsePathStyle: true, Credentials: credentials.NewStaticCredentialsProvider("test-key", "test-secret", "")})}
	data := avatarPNG(t, 384)
	id := strings.Repeat("a", 64)
	if err := store.Put(context.Background(), id, data); err != nil {
		t.Fatal(err)
	}
	out, err := store.Get(context.Background(), id)
	if err != nil || !bytes.Equal(out, data) {
		t.Fatalf("bucket round trip: %v", err)
	}
}
func TestCustomAvatarProfileValidation(t *testing.T) {
	h, _ := testHub(t, testWorld())
	c := &client{send: make(chan []byte, 20), done: make(chan struct{})}
	id := strings.Repeat("b", 64)
	if err := h.handle(c, marshal(map[string]any{"type": "join", "name": "Custom", "avatar": 2, "customAvatar": id})); err != nil {
		t.Fatal(err)
	}
	if c.player.CustomAvatar != id {
		t.Fatal("custom avatar not broadcast")
	}
	if err := h.handle(c, marshal(map[string]any{"type": "profile", "name": "Custom", "avatar": 2, "customAvatar": "../../credentials"})); err == nil {
		t.Fatal("invalid avatar accepted")
	}
	if err := h.handle(c, marshal(map[string]any{"type": "profile", "name": "Custom", "avatar": 0})); err != nil || c.player.CustomAvatar != "" {
		t.Fatal("default selection did not clear custom avatar")
	}
}

// Opt-in browser integration runs the production HTTP handler with an isolated
// storage fixture, so it needs neither Railway credentials nor a second server.
func TestAvatarBrowserFlow(t *testing.T) {
	if os.Getenv("RUN_BROWSER_AVATARS") != "1" {
		t.Skip("set RUN_BROWSER_AVATARS=1 after npm run build")
	}
	frontend, err := newFrontendHandler("../dist")
	if err != nil {
		t.Fatal(err)
	}
	defer frontend.root.Close()
	var office world
	if err = json.Unmarshal(worldJSON, &office); err != nil {
		t.Fatal(err)
	}
	h := newHub(office, nil)
	defer h.close()
	h.avatars = newAvatarService(&memoryAvatars{images: map[string][]byte{}})
	server := httptest.NewUnstartedServer(h.handlerWithFrontend(frontend))
	h.origins["http://"+server.Listener.Addr().String()] = true
	server.Start()
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "node", "scripts/avatar-smoke.mjs")
	cmd.Dir = ".."
	cmd.Env = append(os.Environ(), "AVATAR_TEST_URL="+server.URL)
	output, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("browser: %v\n%s", err, output)
	}
	t.Log(string(output))
}
