.PHONY: install dev build start test clean

# Install all dependencies
install:
	npm install
	cd server && npm install
	cd client && npm install

# Run both server and client in development mode
dev:
	npm run dev

# Run only the server
dev-server:
	cd server && npm run dev

# Run only the client
dev-client:
	cd client && npm run dev

# Build for production
build:
	npm run build

# Start production server
start:
	npm run start

# Run tests
test:
	npm run test

# Clean build artifacts
clean:
	rm -rf server/dist
	rm -rf client/dist
	rm -rf node_modules
	rm -rf server/node_modules
	rm -rf client/node_modules
