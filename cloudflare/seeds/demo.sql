-- DEMO ONLY. Durations, names and working hours are invented examples.
INSERT OR IGNORE INTO services(id,title_hy,title_ru,price_min,price_max,duration,sort_order) VALUES
 ('cut','Կտրվածք','Стрижка',2000,2000,30,1),
 ('scissors','Մկրատով կտրվածք','Стрижка ножницами',3000,3000,45,2),
 ('beard','Մորուքի մոդելավորում','Моделирование бороды',2000,2000,30,3),
 ('shave','Սափրվել','Бритьё',1000,2000,30,4),
 ('face','Դեմքի խնամք','Уход за лицом',3000,3000,30,5),
 ('darsonval','Դարսոնվալ','Дарсонваль',1000,3000,20,6),
 ('dry','Ֆեն','Сушка феном',1000,1000,15,7),
 ('wash','Լվանալ','Мытьё головы',500,500,10,8);
-- statement-breakpoint
INSERT OR IGNORE INTO barbers(id,name,description,online_enabled) VALUES
 ('demo-a','Դեմո վարպետ Ա','Вымышленный мастер · Демонстрация',1),
 ('demo-b','Դեմո վարպետ Բ','Вымышленный мастер · Демонстрация',1),
 ('demo-c','Դեմո վարպետ Գ','Вымышленный мастер · Демонстрация',1);
-- statement-breakpoint
INSERT OR IGNORE INTO barber_services(barber_id,service_id) SELECT b.id,s.id FROM barbers b CROSS JOIN services s WHERE b.id LIKE 'demo-%';
-- statement-breakpoint
INSERT OR IGNORE INTO working_hours(id,barber_id,weekday,start_minute,end_minute)
SELECT b.id||':'||d.value||':am',b.id,d.value,600,840 FROM barbers b CROSS JOIN json_each('[0,1,2,3,4,5]') d WHERE b.id LIKE 'demo-%';
-- statement-breakpoint
INSERT OR IGNORE INTO working_hours(id,barber_id,weekday,start_minute,end_minute)
SELECT b.id||':'||d.value||':pm',b.id,d.value,900,1140 FROM barbers b CROSS JOIN json_each('[0,1,2,3,4,5]') d WHERE b.id LIKE 'demo-%';

