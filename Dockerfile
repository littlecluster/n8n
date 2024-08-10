# Stage 1: Build the application
FROM node:20-bullseye AS builder

# Install Git, build tools, and Python
RUN apt-get update && \
    apt-get install -y git build-essential python3 && \
    rm -rf /var/lib/apt/lists/*

# Enable corepack and ensure pnpm is set up
RUN corepack enable && corepack prepare pnpm@latest --activate

# Set the working directory inside the container
WORKDIR /app

# Clone the repository
RUN git clone https://github.com/littlecluster/n8n.git .

# Install all dependencies (including devDependencies) using pnpm with verbose logging
RUN pnpm install --loglevel verbose

# Build the project
RUN pnpm build

# Define execution command
CMD ["pnpm", "start"]

