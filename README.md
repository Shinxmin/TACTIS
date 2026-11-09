# GIF

영상 주소를 넣으면 에디터로 불러와서 원하는 구간을 GIF로 바꿔주는 웹입니다.

## 두 가지 실행 방식

| 방식 | 지원하는 주소 |
| --- | --- |
| **정적 페이지만** (GitHub Pages 등에 `index.html`만 올림) | 외부 접근(CORS)을 허용하는 영상 파일 직접 링크, 또는 내 컴퓨터의 파일 |
| **서버 함께 실행** (`server.js`) | 유튜브·비메오·X·인스타그램 등 [yt-dlp가 지원하는 사이트](https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md)와 모든 영상 파일 링크 |

페이지가 서버에서 열리면 자동으로 서버 모드로 동작합니다. GIF 변환 자체는 어느 방식이든 브라우저에서 합니다.

## 서버 실행

필요한 것: Node.js 18+, [yt-dlp](https://github.com/yt-dlp/yt-dlp), ffmpeg (npm 패키지 설치는 필요 없음)

```bash
# 예: macOS
brew install yt-dlp ffmpeg
# 예: Ubuntu
sudo apt install ffmpeg && pip install -U yt-dlp

npm start
# → http://localhost:3000
```

### Docker

```bash
docker build -t gif .
docker run -p 3000:3000 gif
```

Render, Railway, Fly.io 같은 서비스에 이 Dockerfile 그대로 배포할 수 있습니다.

### 설정 (환경 변수)

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `PORT` | `3000` | 포트 |
| `MAX_DURATION` | `1200` | 받을 수 있는 영상 최대 길이(초) |
| `MAX_FILESIZE` | `500M` | 받을 수 있는 최대 파일 크기 |
| `MAX_HEIGHT` | `720` | 받을 영상의 최대 세로 해상도 |
| `CACHE_TTL_MIN` | `60` | 받은 영상을 보관하는 시간(분) |
| `DOWNLOAD_TIMEOUT_SEC` | `300` | 다운로드 제한 시간(초) |
| `YTDLP_COOKIES` | (없음) | 쿠키 파일(cookies.txt) 경로. 유튜브가 "봇이 아닌지 확인"을 요구할 때 사용 |
| `ALLOW_PRIVATE` | (없음) | `1`이면 localhost·내부망 주소 허용 (테스트용) |

유튜브 등 사이트가 바뀌면 yt-dlp도 업데이트해야 합니다 (`yt-dlp -U` 또는 Docker 이미지 재빌드).

클라우드 서버(데이터센터 IP)에서는 유튜브가 "Sign in to confirm you’re not a bot" 오류로 막는 경우가 많습니다. 이때는 브라우저에서 내보낸 `cookies.txt`를 서버에 두고 `YTDLP_COOKIES`로 경로를 지정하세요 ([방법](https://github.com/yt-dlp/yt-dlp/wiki/FAQ#how-do-i-pass-cookies-to-yt-dlp)). 집 PC에서 실행하면 보통 쿠키 없이 됩니다.
