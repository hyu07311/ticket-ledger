import React from 'react';
import { render, screen } from '@testing-library/react';
// App.jsx 파일이 App.js, App.jsx, App.tsx 등 어떤 이름으로 저장되었는지에 따라
// import 경로는 './App'만 남기는 것이 가장 안전합니다.
import App from './App'; 

// 테스트 이름 변경: 장부 앱의 제목이 렌더링되는지 확인
test('renders the main ledger title', () => {
  render(<App />);
  
  // 저희가 만든 장부 앱의 제목인 '사랑방극회 제 85회 티켓판매 장부' 텍스트가 있는지 확인
  const titleElement = screen.getByText(/사랑방극회 제 85회 티켓판매 장부/i);
  
  // 이 제목 요소가 화면에 나타나는지 기대(expect)합니다.
  expect(titleElement).toBeInTheDocument();
});

// 테스트 이름 변경: 핵심 UI 요소인 '판매 정보 저장' 버튼이 있는지 확인
test('renders the save button', () => {
  render(<App />);

  // '판매 정보 저장' 버튼을 찾습니다.
  const saveButton = screen.getByRole('button', { name: /판매 정보 저장/i }); 
  
  // 버튼이 화면에 있는지 확인합니다.
  expect(saveButton).toBeInTheDocument();
});