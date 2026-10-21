package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"image/png"
	"io"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

const maxAvatarBytes = 1024 * 1024
const avatarSpec = `Create a transparent PNG pixel-art sprite sheet, exactly 384 x 256 pixels (6 columns x 4 rows of 64 x 64 cells). Rows: down, left, right, up. Columns: idle, walk 1, walk 2, seated, dance 1, dance 2. Keep each character inside its cell, feet at (32, 58); no labels, gutters, shadows outside the cell, or background. All 24 cells must contain the same character in the corresponding pose. Upload the raw PNG bytes encoded as standard base64 (no data URL) with upload_avatar and the temporary upload code from the user's avatar selector. Only that browser receives the selection; there is no public gallery. Never request bucket credentials. The code expires after 30 minutes and permits one successful upload.`

var avatarIDPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)

type avatarStorage interface {
	Put(context.Context, string, []byte) error
	Get(context.Context, string) ([]byte, error)
}
type bucketAvatars struct {
	client *s3.Client
	bucket string
}

func (s *bucketAvatars) Put(ctx context.Context, id string, data []byte) error {
	_, err := s.client.PutObject(ctx, &s3.PutObjectInput{Bucket: aws.String(s.bucket), Key: aws.String("avatars/" + id + ".png"), Body: bytes.NewReader(data), ContentType: aws.String("image/png")})
	return err
}
func (s *bucketAvatars) Get(ctx context.Context, id string) ([]byte, error) {
	out, err := s.client.GetObject(ctx, &s3.GetObjectInput{Bucket: aws.String(s.bucket), Key: aws.String("avatars/" + id + ".png")})
	if err != nil {
		return nil, err
	}
	defer out.Body.Close()
	data, err := io.ReadAll(io.LimitReader(out.Body, maxAvatarBytes+1))
	if len(data) > maxAvatarBytes {
		return nil, errors.New("avatar too large")
	}
	return data, err
}
func avatarStorageFromEnv() (avatarStorage, error) {
	endpoint, bucket, key, secret := os.Getenv("AVATAR_BUCKET_ENDPOINT"), os.Getenv("AVATAR_BUCKET_NAME"), os.Getenv("AVATAR_BUCKET_ACCESS_KEY_ID"), os.Getenv("AVATAR_BUCKET_SECRET_ACCESS_KEY")
	if endpoint+bucket+key+secret == "" {
		return nil, nil
	}
	u, err := url.Parse(endpoint)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || bucket == "" || key == "" || secret == "" {
		return nil, errors.New("configure all AVATAR_BUCKET_* credentials with an HTTPS endpoint")
	}
	region := os.Getenv("AVATAR_BUCKET_REGION")
	if region == "" {
		region = "auto"
	}
	client := s3.New(s3.Options{Region: region, BaseEndpoint: aws.String(endpoint), Credentials: credentials.NewStaticCredentialsProvider(key, secret, ""), UsePathStyle: os.Getenv("AVATAR_BUCKET_FORCE_PATH_STYLE") == "true", HTTPClient: &http.Client{Timeout: 20 * time.Second}})
	return &bucketAvatars{client: client, bucket: bucket}, nil
}

type avatarGrant struct {
	Expires  time.Time
	AvatarID string
	Busy     bool
}
type avatarService struct {
	store      avatarStorage
	mu         sync.Mutex
	grants     map[string]*avatarGrant
	slots      chan struct{}
	imageSlots chan struct{}
}

func newAvatarService(store avatarStorage) *avatarService {
	return &avatarService{store: store, grants: make(map[string]*avatarGrant), slots: make(chan struct{}, 4), imageSlots: make(chan struct{}, 32)}
}
func (s *avatarService) session(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json")
	if s.store == nil {
		http.Error(w, "Custom avatars are not configured on this server.", http.StatusServiceUnavailable)
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for token, g := range s.grants {
		if time.Now().After(g.Expires) {
			delete(s.grants, token)
		}
	}
	if r.Method == http.MethodPost {
		if len(s.grants) >= 512 {
			http.Error(w, "Too many pending uploads. Try again later.", 429)
			return
		}
		b := make([]byte, 32)
		if _, err := rand.Read(b); err != nil {
			http.Error(w, "Could not create upload code", 500)
			return
		}
		token := hex.EncodeToString(b)
		s.grants[token] = &avatarGrant{Expires: time.Now().Add(30 * time.Minute)}
		_ = json.NewEncoder(w).Encode(map[string]string{"token": token})
		return
	}
	token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	g := s.grants[token]
	if g == nil {
		http.Error(w, "Upload code expired. Create another code.", http.StatusNotFound)
		return
	}
	_ = json.NewEncoder(w).Encode(map[string]string{"avatarId": g.AvatarID})
}
func (s *avatarService) image(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if s.store == nil || !avatarIDPattern.MatchString(id) {
		http.NotFound(w, r)
		return
	}
	select {
	case s.imageSlots <- struct{}{}:
		defer func() { <-s.imageSlots }()
	default:
		w.Header().Set("Retry-After", "1")
		http.Error(w, "Try again shortly", http.StatusServiceUnavailable)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	data, err := s.store.Get(ctx, id)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	http.ServeContent(w, r, id+".png", time.Time{}, bytes.NewReader(data))
}

type uploadAvatarInput struct {
	UploadCode string `json:"uploadCode" jsonschema:"Temporary upload code supplied by the user's browser"`
	PNGBase64  string `json:"pngBase64" jsonschema:"Standard base64-encoded transparent PNG sprite sheet (384 x 256 pixels), maximum decoded size 1 MiB"`
}
type uploadAvatarOutput struct {
	AvatarID string `json:"avatarId"`
	Message  string `json:"message"`
}

func (s *avatarService) upload(ctx context.Context, _ *mcp.CallToolRequest, in uploadAvatarInput) (*mcp.CallToolResult, uploadAvatarOutput, error) {
	fail := func(message string) (*mcp.CallToolResult, uploadAvatarOutput, error) {
		return &mcp.CallToolResult{IsError: true, Content: []mcp.Content{&mcp.TextContent{Text: message}}}, uploadAvatarOutput{}, nil
	}
	if s.store == nil {
		return fail("Bucket storage is not configured on this server.")
	}
	s.mu.Lock()
	g := s.grants[in.UploadCode]
	if g == nil || time.Now().After(g.Expires) || g.Busy || g.AvatarID != "" {
		s.mu.Unlock()
		return fail("Upload code is invalid, expired, busy, or already used. Ask the user for a fresh code from the avatar selector.")
	}
	g.Busy = true
	s.mu.Unlock()
	defer func() { s.mu.Lock(); g.Busy = false; s.mu.Unlock() }()
	select {
	case s.slots <- struct{}{}:
		defer func() { <-s.slots }()
	default:
		return fail("Uploads are busy. Retry shortly.")
	}
	if len(in.PNGBase64) > base64.StdEncoding.EncodedLen(maxAvatarBytes) {
		return fail("PNG exceeds 1 MiB.")
	}
	data, err := base64.StdEncoding.DecodeString(in.PNGBase64)
	if err != nil {
		return fail("Provide standard base64 PNG bytes without a data URL prefix.")
	}
	config, err := png.DecodeConfig(bytes.NewReader(data))
	if err != nil || config.Width != 384 || config.Height != 256 {
		return fail("PNG must be exactly 384 x 256 pixels. Call avatar_spec for the layout.")
	}
	img, err := png.Decode(bytes.NewReader(data))
	if err != nil {
		return fail("PNG is corrupt.")
	}
	visible, transparent := false, false
	for y := 0; y < 256; y++ {
		for x := 0; x < 384; x++ {
			_, _, _, alpha := img.At(x, y).RGBA()
			visible = visible || alpha > 0
			transparent = transparent || alpha < 65535
		}
	}
	if !visible || !transparent {
		return fail("Use a visible character on a transparent background; fully blank or opaque sheets are not supported.")
	}
	// Re-encode to discard metadata and ensure only a decoded raster reaches storage.
	var clean bytes.Buffer
	if err = png.Encode(&clean, img); err != nil {
		return fail("Could not encode PNG.")
	}
	if clean.Len() > maxAvatarBytes {
		return fail("PNG exceeds 1 MiB after normalization.")
	}
	sum := sha256.Sum256(clean.Bytes())
	id := hex.EncodeToString(sum[:])
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	if err = s.store.Put(ctx, id, clean.Bytes()); err != nil {
		return fail("Bucket upload failed. Retry with the same code.")
	}
	s.mu.Lock()
	g.AvatarID = id
	s.mu.Unlock()
	return nil, uploadAvatarOutput{AvatarID: id, Message: "Avatar stored. The browser with this upload code will select it automatically while the selector remains open. Save the profile or enter the office to use it."}, nil
}
func (s *avatarService) mcpHandler() http.Handler {
	server := mcp.NewServer(&mcp.Implementation{Name: "bespingle-avatars", Version: "1.0.0"}, nil)
	mcp.AddTool(server, &mcp.Tool{Name: "avatar_spec", Description: "Get the sprite sheet format and instructions for designing a custom Bespingle avatar."}, func(context.Context, *mcp.CallToolRequest, struct{}) (*mcp.CallToolResult, map[string]string, error) {
		return nil, map[string]string{"instructions": avatarSpec}, nil
	})
	mcp.AddTool(server, &mcp.Tool{Name: "upload_avatar", Description: "Upload a custom avatar PNG to Bespingle's bucket for the browser that supplied an upload code. Call avatar_spec before designing."}, s.upload)
	return mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return server }, &mcp.StreamableHTTPOptions{Stateless: true, JSONResponse: true})
}
func (h *hub) avatarOrigin(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if origin := r.Header.Get("Origin"); origin != "" && !h.origins[origin] {
			http.Error(w, "Origin not allowed", 403)
			return
		}
		// Browser-only creation requires a permitted Origin; MCP clients can omit it.
		if r.URL.Path == "/api/avatar-session" && r.Method == http.MethodPost && !h.origins[r.Header.Get("Origin")] {
			http.Error(w, "Origin required", 403)
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, 2*maxAvatarBytes)
		next.ServeHTTP(w, r)
	})
}
