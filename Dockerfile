FROM golang:1.26-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd/ ./cmd/
COPY internal/ ./internal/
RUN CGO_ENABLED=0 go build -o /streamdrop ./cmd/streamdrop

FROM alpine:3.19
RUN apk add --no-cache ca-certificates
COPY --from=build /streamdrop /streamdrop
COPY public /public
COPY templates /templates
EXPOSE 3000
ENV PORT=3000
ENV STREAMDROP_SERVER=https://streamdrop.app
CMD ["/streamdrop"]
