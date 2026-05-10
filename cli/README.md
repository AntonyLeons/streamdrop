# StreamDrop CLI

The StreamDrop CLI allows you to securely send and receive files (and entire folders) directly from your terminal. It uses the exact same end-to-end encryption (AES-GCM) and HTTP streaming backend as the web app, but optimized for the command line.

## Features

- **End-to-End Encrypted**: Files are encrypted and decrypted locally; the server never sees your data.
- **Streaming**: Handles massive files without using extra RAM.
- **Folder Support**: Send an entire directory and it will be archived (`tar`) on the fly. The receiver automatically extracts it on the fly.
- **Live Progress**: Real-time progress bars with speed (MB/s) and ETA.
- **Terminal QR Codes**: Easily share the receive link to a mobile device.

## Installation

### macOS / Linux (Homebrew)
```bash
brew tap AntonyLeons/tap
brew install streamdrop-cli
```

### Windows (Scoop & Chocolatey)
```powershell
# Scoop
scoop bucket add antonyleons https://github.com/AntonyLeons/scoop-bucket
scoop install streamdrop-cli

### From Source
Ensure you have [Bun](https://bun.sh/) installed, then build the binary:

```bash
git clone https://github.com/AntonyLeons/streamdrop.git
cd streamdrop
bun run cli:build
```

You can then link it or move it to your PATH:
```bash
# Example: symlink to your local bin
ln -s $(pwd)/dist/streamdrop-cli /usr/local/bin/streamdrop
```

## Usage

### Sending a File

```bash
streamdrop send my-video.mp4
```
*Output:* Generates a secure share link and a QR code in your terminal. It will wait until a receiver connects before starting the encrypted stream.

### Receiving a File

```bash
streamdrop receive "https://streamdrop.app/xyz123#key..."
```
*Output:* Connects to the sender, downloads, decrypts, and saves the file to your current directory.

### Sending a Folder

You can pass a directory directly to `send`:
```bash
streamdrop send ./my-project
```
The CLI will automatically use `tar` to archive the folder on the fly. On the receiving end, the StreamDrop CLI will detect the archive and automatically extract it back into a folder without saving the raw `.tar` file to disk.

If the receiver wants to just save the `.tar` file without extracting it, they can use the `--no-extract` flag:
```bash
streamdrop receive "https://streamdrop.app/xyz123#key..." --no-extract
```

### Custom Save Path

To save a received file under a different name or location:
```bash
streamdrop receive "https://streamdrop.app/xyz123#key..." --out ~/Downloads/custom-name.mp4
```

*(Note: If a file already exists and you don't provide `--out`, StreamDrop will automatically append a counter like `file (1).mp4` to prevent overwriting.)*

## Configuration (Custom Server)

By default, the CLI uses `https://streamdrop.app`. If you are self-hosting StreamDrop, you can point the CLI to your own server in three ways:

**1. Command Line Flag (Per Run)**
```bash
streamdrop send my-file.txt --server http://192.168.1.10:3000
```

**2. Environment Variable**
```bash
export STREAMDROP_SERVER="http://192.168.1.10:3000"
streamdrop send my-file.txt
```

**3. Global Config File (Recommended)**
Create a `.streamdroprc` file in your home directory (`~/.streamdroprc`) and add your server URL:
```ini
SERVER=http://192.168.1.10:3000
```
The CLI will automatically read this file every time it runs.
