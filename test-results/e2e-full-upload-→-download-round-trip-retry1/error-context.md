# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: e2e.spec.ts >> full upload → download round-trip
- Location: tests/e2e.spec.ts:215:1

# Error details

```
Test timeout of 30000ms exceeded.
```

# Page snapshot

```yaml
- main [ref=e2]:
  - generic [ref=e4]:
    - generic [ref=e5]: SD
    - generic [ref=e6]:
      - heading "StreamDrop" [level=1] [ref=e7]
      - paragraph [ref=e8]: End-to-end encrypted. Zero storage. Real-time.
  - generic [ref=e9]:
    - generic [ref=e10]:
      - generic [ref=e11]:
        - generic [ref=e12]: Session
        - generic [ref=e13]: xT-uytQLMrVT
      - link "CLI recipes" [ref=e14] [cursor=pointer]:
        - /url: /recipes?id=xT-uytQLMrVT
    - button "Drop file to upload" [ref=e15] [cursor=pointer]:
      - generic [ref=e16]:
        - img [ref=e18]
        - generic [ref=e21]: Drop your files here
        - generic [ref=e22]: or click to browse · encrypted before upload
      - button "Choose File" [ref=e23]
    - generic [ref=e24]:
      - generic [ref=e25]: AES-256-GCM
      - generic [ref=e27]: Zero knowledge relay
      - generic [ref=e29]: Key never leaves browser
    - generic [ref=e31]:
      - generic [ref=e34]: Key
      - generic [ref=e35]: ›
      - generic [ref=e38]: Encrypt
      - generic [ref=e39]: ›
      - generic [ref=e42]: Wait
      - generic [ref=e43]: ›
      - generic [ref=e46]: Stream
      - generic [ref=e47]: ›
      - generic [ref=e50]: Share
    - generic [ref=e51]: transfer.txt · 41 B
    - generic [ref=e52]:
      - generic [ref=e53]: Files
      - generic [ref=e55]:
        - generic [ref=e56]:
          - generic [ref=e57]:
            - generic [ref=e58]: transfer.txt · 41 B
            - generic [ref=e59]: Waiting for receiver
            - generic [ref=e60]: 0 downloads
            - generic [ref=e62]:
              - img [ref=e63]
              - text: Encrypted
          - generic [ref=e67]:
            - button "curl" [ref=e68] [cursor=pointer]
            - button "wget" [ref=e69] [cursor=pointer]
            - button "Download" [ref=e70] [cursor=pointer]
            - button "QR" [ref=e71] [cursor=pointer]
            - button "Delete" [ref=e72] [cursor=pointer]
        - generic [ref=e73]:
          - generic [ref=e74]: Share link
          - generic [ref=e75]:
            - textbox [ref=e76]: http://localhost:4000/xT-uytQLMrVT#PWB7W5yr9wwJiZSnCwkpRZ1PdkjYr0RbrtZz6QULUug,transfer.txt
            - button "Copy" [ref=e77] [cursor=pointer]
```