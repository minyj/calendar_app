#!/bin/bash

# 간단한 배포 스크립트
# 사용법: ./deploy.sh 또는 ./deploy.sh "커밋 메시지"

cd /Users/min-yunjeong/Claude

# 변경사항 확인
echo "📝 변경사항 확인 중..."
git status --short

# 모든 파일 추가
git add .

# 커밋 메시지 설정
if [ -n "$1" ]; then
    MESSAGE="$1"
else
    MESSAGE="Update: $(date +'%Y-%m-%d %H:%M:%S')"
fi

# 커밋
echo "💾 커밋 중: $MESSAGE"
git commit -m "$MESSAGE"

# 푸시
echo "🚀 GitHub로 배포 중..."
git push origin main

if [ $? -eq 0 ]; then
    echo "✅ 배포 완료!"
    echo "📍 배포 주소: https://minyj.github.io/calendar_app/"
else
    echo "❌ 배포 실패. 위의 에러를 확인해주세요."
    exit 1
fi
