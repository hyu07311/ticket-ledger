import React, { useState, useEffect, useMemo } from 'react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, onAuthStateChanged } from 'firebase/auth'; 
import { getFirestore, doc, addDoc, onSnapshot, collection, query, serverTimestamp, deleteDoc, writeBatch } from 'firebase/firestore';
import { Loader2, MinusCircle, CheckCircle, Gift, CreditCard, Banknote, Trash2, LayoutDashboard, AlertCircle, BarChart3, Users } from 'lucide-react';

// =================================================================
// 🚨 [Firebase Config]
// =================================================================
const firebaseConfig = {
    apiKey: "AIzaSyCTvZ70hjEpa5CbleXQT1EZnO_CFutajPM",
    authDomain: "sarangbang-ledger.firebaseapp.com",
    projectId: "sarangbang-ledger",
    storageBucket: "sarangbang-ledger.firebasestorage.app",
    messagingSenderId: "795422937912",
    appId: "1:795422937912:web:b97effbc6c39aee76527cd",
    measurementId: "G-YT1L1TK4ZL"
}; 

const appId = firebaseConfig.projectId; 
const TICKET_PRICE = 1000;
const PHOTOCARD_PRICE = 1000;
const BASE_COLLECTION_PATH = `/artifacts/${appId}/public/data/`; 

const currencyFormatter = new Intl.NumberFormat('ko-KR', {
  style: 'currency',
  currency: 'KRW',
});

// =================================================================
// 🧮 [계산 로직]
// =================================================================
const calculateSaleDetails = (tickets, photocards, amountReceived, notes) => {
  const ticketCost = (tickets || 0) * TICKET_PRICE;
  const photoCost = (photocards || 0) * PHOTOCARD_PRICE;
  const expectedPrice = ticketCost + photoCost;
  const diff = (amountReceived || 0) - expectedPrice;
  const isMemberFreeEntry = notes?.trim().includes('부원'); 
  
  let status = '정상 판매';
  let isWarning = false;
  let donation = 0;

  if (isMemberFreeEntry) {
    return { expectedPrice, donation: 0, status: '부원 무료 입장 (Pass)', isWarning: false, isMemberFreeEntry: true };
  }

  if (tickets === 0 && photocards === 0 && amountReceived > 0) {
      return { expectedPrice: 0, donation: amountReceived, status: `순수 후원금 (+${currencyFormatter.format(amountReceived)})`, isWarning: false, isMemberFreeEntry: false };
  }

  if (tickets === 0 && photocards > 0) {
      if (diff >= 0) {
          status = diff > 0 ? `포토카드 판매 (후원 +${currencyFormatter.format(diff)})` : '포토카드 판매';
          donation = diff;
      } else {
          status = `포토카드 판매 (차액 ${currencyFormatter.format(diff)} 무시)`;
          isWarning = false; 
          donation = 0; 
      }
      return { expectedPrice, donation, status, isWarning, isMemberFreeEntry: false };
  }

  if (tickets > 0) {
      if (diff > 0) {
        status = `후원/기부 포함 (+${currencyFormatter.format(diff)})`;
        donation = diff;
        isWarning = false;
      } else if (diff < 0) {
        status = `금액 부족 (${currencyFormatter.format(Math.abs(diff))})`;
        donation = diff;
        isWarning = true; 
      } else {
        status = '정상 판매';
        donation = 0;
        isWarning = false;
      }
  } else if (amountReceived === 0 && (tickets > 0 || photocards > 0)) {
      status = '무료 제공 (확인 필요)';
      isWarning = true;
  }

  return { expectedPrice, donation, status, isWarning, isMemberFreeEntry };
};

const App = () => {
  const [db, setDb] = useState(null);
  const [userId, setUserId] = useState(null);
  const [isAuthReady, setIsAuthReady] = useState(false);
  
  // sales: 현재 선택된 회차의 데이터 (배열)
  const [sales, setSales] = useState([]);
  // allSessionData: 누적 통계용 전체 데이터 (객체 {session_1: [], session_2: [] ...})
  const [allSessionData, setAllSessionData] = useState({});
  
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState(null);
  const [showEntryModal, setShowEntryModal] = useState(false);
  const [showResetModal, setShowResetModal] = useState(false);

  const [currentSession, setCurrentSession] = useState('session_1');
  
  const sessionOptions = [
      { id: 'session_test', name: '테스트 (Test)' },
      { id: 'session_1', name: '1회차 공연' },
      { id: 'session_2', name: '2회차 공연' },
      { id: 'session_3', name: '3회차 공연' },
      { id: 'session_4', name: '4회차 공연' },
      { id: 'session_5', name: '5회차 공연' },
      { id: 'session_6', name: '6회차 공연' },
      // 누적 통계 옵션
      { id: 'cumulative', name: '📊 전체 누적 통계 (Total)' }
  ];

  // 실제 공연 회차 리스트 (통계용)
  const realSessions = ['session_1', 'session_2', 'session_3', 'session_4', 'session_5', 'session_6'];

  const currentCollectionPath = useMemo(() => `${BASE_COLLECTION_PATH}${currentSession}`, [currentSession]);

  const [newEntry, setNewEntry] = useState({
    type: '현금',
    amountReceived: '',
    tickets: '',
    photocards: '',
    notes: '',
  });

  // Firebase Init
  useEffect(() => {
    if (!firebaseConfig?.apiKey) {
        setError("API Key 누락");
        setIsAuthReady(true); setIsLoading(false); return; 
    }
    try {
      const app = initializeApp(firebaseConfig);
      const firestore = getFirestore(app);
      const authInstance = getAuth(app);
      setDb(firestore);

      const unsubscribe = onAuthStateChanged(authInstance, async (user) => {
        if (user) setUserId(user.uid);
        else await signInAnonymously(authInstance);
        setIsAuthReady(true);
      });
      return () => unsubscribe();
    } catch (e) {
      console.error(e); setError("초기화 실패"); setIsAuthReady(true); setIsLoading(false);
    }
  }, []);

  // Data Fetching Logic
  useEffect(() => {
    if (!isAuthReady || !db) return;
    setIsLoading(true);

    // 1. 누적 통계 모드일 때
    if (currentSession === 'cumulative') {
        const unsubscribes = realSessions.map(sessionId => {
            const q = query(collection(db, `${BASE_COLLECTION_PATH}${sessionId}`));
            return onSnapshot(q, (snapshot) => {
                const fetched = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
                setAllSessionData(prev => ({
                    ...prev,
                    [sessionId]: fetched
                }));
            });
        });
        
        setIsLoading(false);
        return () => unsubscribes.forEach(unsub => unsub());
    } 
    // 2. 일반 회차 모드일 때
    else {
        const q = query(collection(db, currentCollectionPath));
        const unsubscribe = onSnapshot(q, (snapshot) => {
            const fetched = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            fetched.sort((a, b) => (b.timestamp?.toDate() || 0) - (a.timestamp?.toDate() || 0));
            setSales(fetched);
            setIsLoading(false);
        }, (err) => {
            console.error(err); setSales([]); setError("데이터 로드 실패"); setIsLoading(false);
        });
        return () => unsubscribe();
    }
  }, [isAuthReady, db, currentSession, currentCollectionPath]);

  // 통계 데이터 가공 (누적 모드일 때 사용)
  const cumulativeStats = useMemo(() => {
      if (currentSession !== 'cumulative') return null;

      const statsBySession = realSessions.map(sessionId => {
          const sessionData = allSessionData[sessionId] || [];
          const sessionTotal = sessionData.reduce((acc, sale) => {
              // 매출액 구분
              if (sale.type === '현금') acc.cash += sale.amountReceived || 0;
              else if (sale.type === '계좌') acc.account += sale.amountReceived || 0;
              
              // 관람객 수
              acc.guests += (sale.tickets || 0);
              return acc;
          }, { cash: 0, account: 0, guests: 0 });

          return {
              id: sessionId,
              name: sessionOptions.find(o => o.id === sessionId)?.name.replace(' (실제 공연)', '').replace('회차 공연', '회'),
              totalRevenue: sessionTotal.cash + sessionTotal.account,
              sessionCash: sessionTotal.cash,
              sessionAccount: sessionTotal.account,
              totalGuests: sessionTotal.guests
          };
      });

      const grandTotal = statsBySession.reduce((acc, s) => ({
          revenue: acc.revenue + s.totalRevenue,
          guests: acc.guests + s.totalGuests,
          cash: acc.cash + s.sessionCash,       // [추가됨] 현금 누적
          account: acc.account + s.sessionAccount // [추가됨] 계좌 누적
      }), { revenue: 0, guests: 0, cash: 0, account: 0 });

      // 그래프용 최대값
      const maxRevenue = Math.max(...statsBySession.map(s => s.totalRevenue), 1);
      const maxGuests = Math.max(...statsBySession.map(s => s.totalGuests), 1);

      return { statsBySession, grandTotal, maxRevenue, maxGuests };
  }, [allSessionData, currentSession]);

  const handleChange = (e) => {
    const { name, value, type } = e.target;
    setNewEntry(prev => ({
      ...prev,
      [name]: (type === 'number' || name === 'amountReceived') ? Number(value.replace(/[^0-9]/g, '')) : value,
    }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!db || !userId) return;

    const tickets = Number(newEntry.tickets || 0);
    const photocards = Number(newEntry.photocards || 0);
    const amountReceived = Number(newEntry.amountReceived || 0);

    if (tickets === 0 && photocards === 0 && amountReceived === 0 && !newEntry.notes.includes('부원')) {
      setShowEntryModal(true); return;
    }
    
    setError(null); setIsSaving(true);

    try {
      await addDoc(collection(db, currentCollectionPath), {
        ...newEntry, tickets, photocards, amountReceived,
        timestamp: serverTimestamp(), userId, notes: newEntry.notes || ''
      });
      setNewEntry({ type: '현금', amountReceived: '', tickets: '', photocards: '', notes: '' });
    } catch (e) {
      console.error(e); setError("저장 실패");
    } finally {
      setIsSaving(false);
    }
  };
  
  const handleDeleteEntry = async (id) => {
    if (!db || !window.confirm('삭제하시겠습니까?')) return;
    try { await deleteDoc(doc(db, currentCollectionPath, id)); } catch (e) { setError("삭제 실패"); }
  };

  const handleResetConfirm = async () => {
    setShowResetModal(false);
    if (!db || sales.length === 0) return;
    setIsSaving(true);
    try {
        const batch = writeBatch(db);
        sales.forEach(s => batch.delete(doc(db, currentCollectionPath, s.id)));
        await batch.commit();
    } catch (e) { setError("초기화 실패"); } finally { setIsSaving(false); }
  };

  const handleEntryModalConfirm = async () => {
    setShowEntryModal(false);
    await handleSubmit({ preventDefault: () => {} });
  };

  const entryDetails = useMemo(() => 
    calculateSaleDetails(Number(newEntry.tickets), Number(newEntry.photocards), Number(newEntry.amountReceived), newEntry.notes), 
    [newEntry]
  );

  const totals = useMemo(() => {
    return sales.reduce((acc, sale) => {
      const { donation, isMemberFreeEntry } = calculateSaleDetails(sale.tickets, sale.photocards, sale.amountReceived, sale.notes);
      
      if (sale.type === '현금') acc.totalCash += sale.amountReceived;
      else if (sale.type === '계좌') acc.totalAccount += sale.amountReceived;
      
      acc.totalDonation += (donation > 0 ? donation : 0); 
      acc.totalExpectedSales += (sale.tickets || 0) * TICKET_PRICE + (sale.photocards || 0) * PHOTOCARD_PRICE;
      acc.totalPhotocards += sale.photocards || 0;
      if (isMemberFreeEntry) acc.totalMembers += sale.tickets || 0; 
      
      return acc;
    }, { totalCash: 0, totalAccount: 0, totalDonation: 0, totalExpectedSales: 0, totalMembers: 0, totalPhotocards: 0 });
  }, [sales]);
  
  if (isLoading) return <div className="flex h-screen items-center justify-center bg-violet-50"><Loader2 className="animate-spin text-violet-600 w-10 h-10" /></div>;

  return (
    <div className="min-h-screen bg-gradient-to-br from-violet-100 via-white to-indigo-100 font-sans text-slate-800 p-4 sm:p-8">
      
      {/* 1. Header Section */}
      <header className="max-w-4xl mx-auto mb-10 text-center">
        <div className="inline-block p-2 bg-white rounded-full shadow-sm mb-4">
             <span className="px-3 py-1 rounded-full bg-violet-100 text-violet-700 text-xs font-bold tracking-wide">
                Season 85
             </span>
        </div>
        <h1 className="text-3xl sm:text-4xl font-extrabold text-transparent bg-clip-text bg-gradient-to-r from-violet-600 to-indigo-600 mb-2">
          사랑방극회 티켓판매 장부
        </h1>

        {/* 회차 선택 */}
        <div className="mt-6 flex justify-center">
             <div className="relative">
                <select
                    value={currentSession}
                    onChange={(e) => setCurrentSession(e.target.value)}
                    className={`appearance-none bg-white border border-violet-200 text-slate-700 py-2 pl-4 pr-10 rounded-full shadow-sm focus:outline-none focus:ring-2 focus:ring-violet-500 font-semibold cursor-pointer ${currentSession === 'cumulative' ? 'bg-indigo-50 border-indigo-500 text-indigo-700' : ''}`}
                >
                    {sessionOptions.map(option => (
                        <option key={option.id} value={option.id}>{option.name}</option>
                    ))}
                </select>
             </div>
        </div>
      </header>

      {error && <div className="max-w-2xl mx-auto mb-6 p-4 bg-red-50 text-red-600 rounded-2xl text-center shadow-sm font-medium">{error}</div>}

      <main className="max-w-5xl mx-auto space-y-8">
        
        {/* ================================================================================= */}
        {/* 📊 A. [통계 모드] 누적 통계 화면 (currentSession === 'cumulative') */}
        {/* ================================================================================= */}
        {currentSession === 'cumulative' && cumulativeStats && (
            <div className="animate-fade-in space-y-6">
                
                {/* 1. 총계 요약 카드 (현금/계좌 추가됨) */}
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 max-w-4xl mx-auto">
                    {/* 총 매출 */}
                    <div className="col-span-2 lg:col-span-2 bg-gradient-to-br from-indigo-600 to-violet-700 rounded-3xl p-6 text-white shadow-xl flex flex-col items-center text-center justify-center">
                        <div className="p-3 bg-white/10 rounded-full mb-3"><Gift className="w-8 h-8" /></div>
                        <p className="text-indigo-100 text-sm font-medium mb-1">총 누적 매출액 (Total)</p>
                        <h2 className="text-3xl sm:text-4xl font-extrabold">{currencyFormatter.format(cumulativeStats.grandTotal.revenue)}</h2>
                    </div>

                    {/* 총 관람객 */}
                    <div className="col-span-2 lg:col-span-2 bg-white rounded-3xl p-6 border border-slate-100 shadow-xl flex flex-col items-center text-center justify-center">
                        <div className="p-3 bg-indigo-50 rounded-full mb-3 text-indigo-600"><Users className="w-8 h-8" /></div>
                        <p className="text-slate-500 text-sm font-medium mb-1">총 누적 관람객 (Guests)</p>
                        <h2 className="text-3xl sm:text-4xl font-extrabold text-slate-800">{cumulativeStats.grandTotal.guests}명</h2>
                    </div>

                    {/* [추가] 현금 총액 */}
                    <div className="bg-white rounded-3xl p-6 border border-slate-100 shadow-md flex flex-col items-center text-center">
                         <div className="p-2 bg-green-50 rounded-full mb-2 text-green-600"><Banknote className="w-5 h-5" /></div>
                         <p className="text-slate-400 text-xs font-bold uppercase">현금 (Cash)</p>
                         <p className="text-lg font-bold text-slate-700 mt-1">{currencyFormatter.format(cumulativeStats.grandTotal.cash)}</p>
                    </div>

                    {/* [추가] 계좌 총액 */}
                    <div className="bg-white rounded-3xl p-6 border border-slate-100 shadow-md flex flex-col items-center text-center">
                         <div className="p-2 bg-blue-50 rounded-full mb-2 text-blue-600"><CreditCard className="w-5 h-5" /></div>
                         <p className="text-slate-400 text-xs font-bold uppercase">계좌 (Account)</p>
                         <p className="text-lg font-bold text-slate-700 mt-1">{currencyFormatter.format(cumulativeStats.grandTotal.account)}</p>
                    </div>
                </div>

                {/* 2. 회차별 막대 그래프 */}
                <div className="bg-white rounded-[2rem] p-8 shadow-lg border border-slate-100 max-w-4xl mx-auto">
                    <h3 className="text-xl font-bold text-slate-800 mb-6 flex items-center">
                        <BarChart3 className="w-6 h-6 mr-2 text-indigo-500"/> 회차별 상세 그래프
                    </h3>
                    
                    {/* 그래프 컨테이너 */}
                    <div className="space-y-6">
                        {cumulativeStats.statsBySession.map((s) => (
                            <div key={s.id} className="relative">
                                <div className="flex justify-between items-end mb-1 text-sm font-semibold">
                                    <span className="w-16 text-slate-500">{s.name}</span>
                                    <div className="flex-1 px-4">
                                        {/* 매출액 그래프 (보라색) */}
                                        <div className="relative h-6 bg-slate-100 rounded-full overflow-hidden flex items-center mb-1">
                                            <div 
                                                className="absolute top-0 left-0 h-full bg-indigo-500 rounded-full transition-all duration-1000"
                                                style={{ width: `${(s.totalRevenue / cumulativeStats.maxRevenue) * 100}%` }}
                                            ></div>
                                            <span className="relative z-10 ml-3 text-xs font-bold text-slate-700">
                                                {currencyFormatter.format(s.totalRevenue)}
                                            </span>
                                        </div>
                                        {/* 관람객 수 그래프 (회색) */}
                                        <div className="relative h-4 bg-slate-100 rounded-full overflow-hidden flex items-center">
                                            <div 
                                                className="absolute top-0 left-0 h-full bg-slate-400 rounded-full transition-all duration-1000"
                                                style={{ width: `${(s.totalGuests / cumulativeStats.maxGuests) * 100}%` }}
                                            ></div>
                                            <span className="relative z-10 ml-3 text-[10px] font-bold text-slate-600">
                                                {s.totalGuests}명
                                            </span>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>
                    <p className="text-center text-xs text-slate-400 mt-8">* 위쪽(보라색)은 매출액, 아래쪽(회색)은 관람객 수입니다.</p>
                </div>
            </div>
        )}


        {/* ================================================================================= */}
        {/* 📝 B. [일반 모드] 기존 입력 폼 및 리스트 (currentSession !== 'cumulative') */}
        {/* ================================================================================= */}
        {currentSession !== 'cumulative' && (
        <>
        {/* 2. Stats Cards */}
        <section className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="col-span-2 bg-gradient-to-r from-violet-500 to-indigo-600 rounded-3xl p-6 text-white shadow-lg shadow-indigo-200 transform hover:-translate-y-1 transition duration-200">
                <div className="flex justify-between items-start">
                    <div>
                        <p className="text-violet-100 text-sm font-medium mb-1">Total Revenue</p>
                        <h3 className="text-3xl font-bold">{currencyFormatter.format(totals.totalCash + totals.totalAccount)}</h3>
                    </div>
                    <div className="p-2 bg-white/20 rounded-xl">
                        <Gift className="w-6 h-6 text-white" />
                    </div>
                </div>
                <div className="mt-4 flex gap-3 text-xs font-medium text-violet-100">
                    <span className="flex items-center"><Banknote className="w-3 h-3 mr-1"/> 현금: {currencyFormatter.format(totals.totalCash)}</span>
                    <span className="flex items-center"><CreditCard className="w-3 h-3 mr-1"/> 계좌: {currencyFormatter.format(totals.totalAccount)}</span>
                </div>
            </div>

            <div className="bg-white rounded-3xl p-5 shadow-md border border-slate-100 flex flex-col items-center justify-center text-center">
                 <div className="p-3 bg-blue-50 text-blue-600 rounded-full mb-2">
                    <LayoutDashboard className="w-5 h-5" />
                 </div>
                 <p className="text-slate-400 text-xs font-medium uppercase tracking-wider">예상 매출액</p>
                 <p className="text-slate-700 text-lg font-bold mt-1">{currencyFormatter.format(totals.totalExpectedSales)}</p>
            </div>

            <div className="bg-white rounded-3xl p-5 shadow-md border border-slate-100 flex flex-col items-center justify-center text-center">
                 <div className="p-3 bg-yellow-50 text-yellow-600 rounded-full mb-2">
                    <Gift className="w-5 h-5" />
                 </div>
                 <p className="text-slate-400 text-xs font-medium uppercase tracking-wider">순수 후원금</p>
                 <p className="text-slate-700 text-lg font-bold mt-1">{currencyFormatter.format(totals.totalDonation)}</p>
            </div>
            
            <div className="col-span-2 md:col-span-4 grid grid-cols-2 gap-4">
                 <div className="bg-white rounded-2xl p-4 shadow-sm border border-slate-100 flex items-center justify-between px-8">
                    <span className="text-slate-500 text-sm font-medium">📸 포토카드 판매</span>
                    <span className="text-indigo-600 font-bold text-lg">{totals.totalPhotocards}개</span>
                 </div>
                 <div className="bg-white rounded-2xl p-4 shadow-sm border border-slate-100 flex items-center justify-between px-8">
                    <span className="text-slate-500 text-sm font-medium">🎭 부원(무료) 입장</span>
                    <span className="text-indigo-600 font-bold text-lg">{totals.totalMembers}명</span>
                 </div>
            </div>
        </section>


        {/* 3. Input Form */}
        <section className="bg-white rounded-[2rem] shadow-xl shadow-slate-200 p-8 border border-white">
          <div className="text-center mb-8">
             <h2 className="text-xl font-bold text-slate-800">티켓 & 굿즈 판매 등록</h2>
             <p className="text-slate-400 text-sm mt-1">티켓 0장일 경우 자동으로 기부금/포토카드 모드로 동작합니다</p>
          </div>

          <form onSubmit={handleSubmit} className="max-w-2xl mx-auto space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
               <div className="bg-slate-50 p-4 rounded-2xl text-center">
                  <label className="block text-xs font-bold text-slate-400 uppercase mb-2">결제 수단</label>
                  <div className="flex justify-center space-x-2">
                      {['현금', '계좌'].map(type => (
                          <button
                            key={type}
                            type="button"
                            onClick={() => setNewEntry(p => ({...p, type}))}
                            className={`px-4 py-2 rounded-xl text-sm font-bold transition-all ${newEntry.type === type ? 'bg-indigo-500 text-white shadow-md' : 'bg-white text-slate-500 hover:bg-slate-200'}`}
                          >
                            {type}
                          </button>
                      ))}
                  </div>
               </div>
               <div className="md:col-span-2 bg-yellow-50/50 p-4 rounded-2xl border border-yellow-100">
                  <label htmlFor="amountReceived" className="block text-xs font-bold text-yellow-600 uppercase mb-2 text-center">받은 금액 (Total Amount)</label>
                  <input
                    type="text"
                    name="amountReceived"
                    value={newEntry.amountReceived ? new Intl.NumberFormat().format(newEntry.amountReceived) : ''}
                    onChange={(e) => setNewEntry(prev => ({ ...prev, amountReceived: e.target.value.replace(/[^0-9]/g, '') }))}
                    className="w-full bg-transparent text-center text-3xl font-extrabold text-yellow-700 placeholder-yellow-300/50 focus:outline-none"
                    placeholder="0"
                    autoComplete="off"
                  />
               </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
                <div className="bg-slate-50 p-4 rounded-2xl text-center">
                    <label className="block text-xs font-bold text-slate-400 uppercase mb-2">티켓 (Ticket)</label>
                    <input type="number" name="tickets" value={newEntry.tickets} onChange={handleChange} placeholder="0" 
                        className="w-full text-center bg-white rounded-xl py-2 font-bold text-slate-700 focus:ring-2 focus:ring-indigo-200 outline-none" />
                </div>
                <div className="bg-slate-50 p-4 rounded-2xl text-center">
                    <label className="block text-xs font-bold text-slate-400 uppercase mb-2">포토카드 (Photo)</label>
                    <input type="number" name="photocards" value={newEntry.photocards} onChange={handleChange} placeholder="0" 
                        className="w-full text-center bg-white rounded-xl py-2 font-bold text-slate-700 focus:ring-2 focus:ring-indigo-200 outline-none" />
                </div>
            </div>

            <div className="bg-slate-50 p-4 rounded-2xl">
                 <label className="block text-xs font-bold text-slate-400 uppercase mb-2 text-center">특이사항 (Memo)</label>
                 <input type="text" name="notes" value={newEntry.notes} onChange={handleChange} placeholder="예: 부원, 지인 할인 등" 
                        className="w-full text-center bg-transparent border-b-2 border-slate-200 py-1 focus:border-indigo-400 focus:outline-none transition-colors" />
            </div>

            <div className={`text-center p-3 rounded-xl text-sm font-medium transition-colors ${entryDetails.isWarning ? 'text-red-500 bg-red-50' : 'text-green-600 bg-green-50'}`}>
                {entryDetails.isWarning ? <MinusCircle className="inline w-4 h-4 mr-1"/> : <CheckCircle className="inline w-4 h-4 mr-1"/>}
                {entryDetails.status}
            </div>

            <button
              type="submit"
              disabled={isSaving}
              className="w-full py-4 bg-gradient-to-r from-violet-600 to-indigo-600 text-white rounded-2xl font-bold text-lg shadow-lg shadow-indigo-200 hover:shadow-xl hover:scale-[1.01] transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isSaving ? '저장 중...' : '판매 등록하기'}
            </button>
          </form>
        </section>

        {/* 4. List Section */}
        <section className="bg-white/80 backdrop-blur-sm rounded-[2rem] p-6 shadow-sm border border-white">
           <div className="flex justify-between items-center mb-6 px-2">
               <h3 className="font-bold text-slate-700">📋 최근 내역</h3>
               <button onClick={() => setShowResetModal(true)} disabled={sales.length === 0} className="text-xs text-red-400 hover:text-red-600 font-medium flex items-center">
                   <Trash2 className="w-3 h-3 mr-1"/> 초기화
               </button>
           </div>
           
           <div className="space-y-3">
               {sales.length === 0 ? (
                   <p className="text-center text-slate-400 py-10">기록된 내역이 없습니다.</p>
               ) : (
                   sales.map((sale) => {
                       const d = calculateSaleDetails(sale.tickets, sale.photocards, sale.amountReceived, sale.notes);
                       return (
                           <div key={sale.id} className="group bg-white p-4 rounded-2xl border border-slate-100 hover:border-violet-200 shadow-sm transition-all flex justify-between items-center">
                               <div className="flex items-center gap-3">
                                   <div className={`p-2 rounded-xl ${sale.type === '현금' ? 'bg-green-100 text-green-600' : 'bg-blue-100 text-blue-600'}`}>
                                       {sale.type === '현금' ? <Banknote size={18}/> : <CreditCard size={18}/>}
                                   </div>
                                   <div>
                                       <p className="font-bold text-slate-700">{currencyFormatter.format(sale.amountReceived)}</p>
                                       <p className="text-xs text-slate-400">
                                            {sale.tickets > 0 && `티켓 ${sale.tickets} `} 
                                            {sale.photocards > 0 && `포토 ${sale.photocards}`}
                                            {sale.tickets === 0 && sale.photocards === 0 && <span className="text-yellow-600 font-bold">순수 후원</span>}
                                            {sale.notes && ` | ${sale.notes}`}
                                       </p>
                                   </div>
                               </div>
                               <div className="text-right">
                                   <span className={`text-xs font-bold px-2 py-1 rounded-lg ${d.isWarning ? 'bg-red-50 text-red-500' : 'bg-slate-50 text-slate-400'}`}>
                                       {d.status}
                                   </span>
                                   <button onClick={() => handleDeleteEntry(sale.id)} className="ml-3 text-slate-300 hover:text-red-500 transition-colors">
                                       <Trash2 size={16}/>
                                   </button>
                               </div>
                           </div>
                       )
                   })
               )}
           </div>
        </section>
        </>
        )}

      </main>

      {/* 모달: 부원/무료 확인 (티켓도 0, 돈도 0일 때만) */}
      {showEntryModal && (
        <div className="fixed inset-0 bg-black/30 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-3xl p-8 max-w-sm w-full text-center shadow-2xl">
            <AlertCircle className="w-12 h-12 text-red-400 mx-auto mb-4" />
            <h3 className="text-lg font-bold text-slate-800">확인 필요</h3>
            <p className="text-slate-500 text-sm mt-2 mb-6">입력된 수량과 금액이 모두 0입니다.<br/>무료 증정인가요?</p>
            <div className="flex gap-3">
               <button onClick={() => setShowEntryModal(false)} className="flex-1 py-3 bg-slate-100 text-slate-600 rounded-xl font-bold">취소</button>
               <button onClick={handleEntryModalConfirm} className="flex-1 py-3 bg-red-500 text-white rounded-xl font-bold shadow-lg shadow-red-200">저장</button>
            </div>
          </div>
        </div>
      )}

      {/* 모달: 초기화 확인 */}
      {showResetModal && (
        <div className="fixed inset-0 bg-black/30 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-3xl p-8 max-w-sm w-full text-center shadow-2xl">
            <Trash2 className="w-12 h-12 text-red-500 mx-auto mb-4" />
            <h3 className="text-lg font-bold text-slate-800">장부 초기화</h3>
            <p className="text-slate-500 text-sm mt-2 mb-6">현재 회차의 모든 기록이 삭제됩니다.<br/>정말 진행하시겠습니까?</p>
            <div className="flex gap-3">
               <button onClick={() => setShowResetModal(false)} className="flex-1 py-3 bg-slate-100 text-slate-600 rounded-xl font-bold">취소</button>
               <button onClick={handleResetConfirm} className="flex-1 py-3 bg-red-600 text-white rounded-xl font-bold shadow-lg shadow-red-200">전체 삭제</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default App;