// 대화방을 고르기 전의 오른쪽 빈 화면. 모바일에서는 목록만 보이므로 숨겨진다(MessagesShell).
export default function MessagesIndexPage() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 bg-gray-50 p-8 text-center">
      <p className="text-sm font-medium text-gray-700">대화방을 선택해 주세요</p>
      <p className="text-xs text-gray-500">
        계약마다 의뢰인과 프리랜서의 대화방이 하나씩 있습니다. 계약 진행 소식도 이곳에 함께 남습니다.
      </p>
    </div>
  );
}
