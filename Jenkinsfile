pipeline {
    agent {
        docker {
            image 'docker:19.03.12-dind'
            args '-v /var/run/docker.sock:/var/run/docker.sock'
        }
    }

    environment {
        REPO_URL = 'github.com/littlecluster/go-proxies.git'
        REPO_DIR = "${env.WORKSPACE}/docker/go-proxies"
        REPO = 'littlecluster/go-proxies'
        PATH = "/usr/local/go/bin:${env.PATH}"
        DOCKER_REGISTRY = 'localhost:5000'
        DOCKER_IMAGE_NAME = 'go-proxies'
        DOCKER_IMAGE_TAG = "latest"
        GITHUB_USERNAME = 'littlecluster'
        GITHUB_EMAIL = "littlecluster@domain.com"
    }

    stages {
        stage('Prepare Environment') {
            steps {
                sh 'apk add --no-cache git curl wget gcc musl-dev'
                sh '''
                    wget -c https://go.dev/dl/go1.22.0.linux-amd64.tar.gz
                    tar -C /usr/local -xzf go1.22.0.linux-amd64.tar.gz
                    export PATH=/usr/local/go/bin:$PATH
                    echo $PATH
                    go version
                '''
            }
        }

        stage('Checkout') {
            steps {
                script {
                    withCredentials([usernamePassword(credentialsId: 'github-access', usernameVariable: 'GITHUB_USERNAME', passwordVariable: 'GITHUB_TOKEN')]) {
                        sh """
                            git clone -b staging https://${GITHUB_USERNAME}:${GITHUB_TOKEN}@${REPO_URL} ${REPO_DIR}
                        """
                    }
                    dir(REPO_DIR) {
                        withCredentials([usernamePassword(credentialsId: 'github-access', usernameVariable: 'GITHUB_USERNAME', passwordVariable: 'GITHUB_TOKEN')]) {
                            sh """
                                git fetch origin
                                git reset --hard origin/staging
                            """
                        }
                    }
                }
            }
        }

        stage('Install Dependencies') {
            steps {
                dir(REPO_DIR) {
                    sh '''
                        export PATH=/usr/local/go/bin:$PATH
                        go mod init ${REPO}
                        go mod tidy
                    '''
                }
            }
        }

        stage('Run Tests') {
            steps {
                dir(REPO_DIR) {
                    sh '''
                        export PATH=/usr/local/go/bin:$PATH
                        go test ./...
                    '''
                }
            }
        }

        stage('Build Docker Image') {
            steps {
                dir(REPO_DIR) {
                    script {
                        docker.build("${DOCKER_REGISTRY}/${DOCKER_IMAGE_NAME}:${DOCKER_IMAGE_TAG}")
                    }
                }
            }
        }

        stage('Push Docker Image') {
            steps {
                script {
                    docker.image("${DOCKER_REGISTRY}/${DOCKER_IMAGE_NAME}:${DOCKER_IMAGE_TAG}").push()
                }
            }
        }

        stage('Merge to Master') {
            steps {
                dir(REPO_DIR) {
                    withCredentials([usernamePassword(credentialsId: 'github-access', usernameVariable: 'GITHUB_USERNAME', passwordVariable: 'GITHUB_TOKEN')]) {
                        sh """
                            git config --global user.email "${GITHUB_EMAIL}"
                            git config --global user.name "${GITHUB_USERNAME}"
                            git checkout master
                            git merge staging
                            git push origin master
                        """
                    }
                }
            }
        }

    }

    post {
        always {
            script {
                echo "Cleaning up the repository directory..."
                sh "rm -rf ${REPO_DIR}"
                echo 'Cleaned up the repository directory'
            }
        }
        success {
            script {
                echo 'Tests passed...'
            }
        }
        failure {
            echo 'Tests failed!'
        }
    }
}
