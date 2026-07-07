# routini

A full-stack TypeScript application

## Features

- Express.js backend with TypeScript
- React frontend with Vite
- Hot module replacement for both client and server
- API proxy configuration
- Type-safe development

## Project Structure

```
routini/
├── server/           # Express.js backend
│   ├── src/
│   │   ├── index.ts  # Server entry point
│   │   └── routes.ts # API routes
│   └── package.json
├── client/           # React frontend
│   ├── src/
│   │   ├── main.tsx  # Client entry point
│   │   └── App.tsx   # Main component
│   └── package.json
├── tests/            # Test files
├── Makefile          # Build commands
└── package.json      # Root package with scripts
```

## Getting Started

### Prerequisites

- Node.js 18 or higher
- npm or yarn

### Installation

```bash
# Install all dependencies
make install
# or
npm run install:all
```

### Development

Start both server and client:

```bash
make dev
# or
npm run dev
```

- Frontend: http://localhost:5173
- Backend: http://localhost:3001

### Building

```bash
make build
# or
npm run build
```

### Production

```bash
make start
# or
npm run start
```

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /health | Health check |
| GET | /api/items | List all items |
| GET | /api/items/:id | Get single item |
| POST | /api/items | Create item |
| DELETE | /api/items/:id | Delete item |
| GET | /api/version | API version |

## Author

Developer

## License

MIT
