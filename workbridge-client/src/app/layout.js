import './globals.css';
import Header from '@/components/layout/Header';
import Footer from '@/components/layout/Footer';

export const metadata = {
  title: {
    default: 'WorkBridge - 프리랜서 매칭 플랫폼',
    template: '%s | WorkBridge',
  },
  description: '프로젝트 등록부터 지원자 비교, 전자 계약, 단계별 안전결제와 정산까지 한곳에서 진행하는 프리랜서 매칭 플랫폼',
};

export default function RootLayout({ children }) {
  return (
    <html lang="ko">
      <body className="min-h-screen flex flex-col">
        <Header />
        <main className="flex-1">{children}</main>
        <Footer />
      </body>
    </html>
  );
}
